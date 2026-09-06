/**
 * Docker relay init contract (no Docker daemon required).
 *
 * Covers the minimal deployment initializer implemented by
 * `deploy/sync-relay/relay-init.mjs` (LOCK-001: no relay-owned CA, server
 * certificates, trust installation, fingerprints, or TLS lifecycle) through
 * bounded `node` subprocess runs plus direct imports of its pure helpers:
 * - First init creates only the token file (0600, strong) and the DB
 *   placeholder (0600); no certificate/private-key artifacts are generated
 *   and no OpenSSL dependency exists.
 * - Without RELAY_PUBLIC_URL no public config artifact is written; with it,
 *   a small versioned config carries only operator-supplied endpoint
 *   metadata (public URL, relay name, versions) — never any token, cert, or
 *   key — with safe modes and secret-free logs.
 * - Second init reuses byte-identical artifacts (config stays identical via
 *   preserved issuedAt); corrupt token/config fails closed without silent
 *   replacement; legacy RELAY_LAN_IP fails fast before any mutation.
 * - Dockerfile/Compose/entrypoint/lockfile/ignore/schema structural checks
 *   (Linux-targeted standard bridge networking with `ports:`, no
 *   RELAY_LAN_IP/host network, container-internal 0.0.0.0 bind with the
 *   deployment flag, frozen lockfile with build-script approval,
 *   secret-free build context, minimal public-config schema, umask 077,
 *   exec of the unchanged relay CLI).
 *
 * All runs use disposable temp roots with exact cleanup. The init itself is
 * allowed off-Linux here via RELAY_ALLOW_NON_LINUX=1 (test-only escape
 * hatch); the shipped entrypoint enforces Linux via `uname` and never sets
 * that variable.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildPublicConfig,
  ensurePublicConfig,
  ensureToken,
  isValidIssuedAt,
  isWildcardPublicHostname,
  resolveTokenFilePath,
  validatePort,
  validatePublicConfigShape,
  validatePublicUrl,
  validateRelayName,
  validateTlsPassthrough,
  writeFileAtomic
} from '../../../deploy/sync-relay/relay-init.mjs'

const REPO_ROOT = resolve(process.cwd())
const INIT_ENTRY = join(REPO_ROOT, 'deploy/sync-relay/relay-init.mjs')
const DOCKERFILE = join(REPO_ROOT, 'deploy/sync-relay/Dockerfile')
const ENTRYPOINT = join(REPO_ROOT, 'deploy/sync-relay/docker-entrypoint.sh')
const COMPOSE = join(REPO_ROOT, 'docker-compose.yml')
const SCHEMA = join(REPO_ROOT, 'deploy/sync-relay/relay-config.schema.json')
const IMAGE_MANIFEST = join(REPO_ROOT, 'deploy/sync-relay/package.json')
const IMAGE_LOCKFILE = join(REPO_ROOT, 'deploy/sync-relay/pnpm-lock.yaml')
const DOCKERIGNORE = join(REPO_ROOT, '.dockerignore')

const PORT = '3044'
const PUBLIC_URL = 'http://192.168.1.50:3044'

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cherry-relay-init-test-'))
}

function runInit(
  root: string,
  overrides: Record<string, string | undefined> = {}
): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    RELAY_ALLOW_NON_LINUX: '1',
    RELAY_PORT: PORT,
    RELAY_DATA_DIR: root,
    RELAY_NAME: 'test-relay',
    ...overrides
  }
  // RELAY_PUBLIC_URL / RELAY_TOKEN_FILE default to unset for tests that do
  // not opt in; explicit empty/whitespace overrides simulate the default
  // Compose `${VAR:-}` expansion and must be preserved.
  if (!('RELAY_PUBLIC_URL' in overrides)) delete env.RELAY_PUBLIC_URL
  if (!('RELAY_LAN_IP' in overrides)) delete env.RELAY_LAN_IP
  if (!('RELAY_TOKEN_FILE' in overrides)) delete env.RELAY_TOKEN_FILE
  const child = spawnSync(process.execPath, [INIT_ENTRY], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' })
  return { status: child.status ?? -1, stdout: child.stdout ?? '', stderr: child.stderr ?? '' }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function snapshotFiles(root: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of readdirSync(root)) out.set(name, sha256Of(join(root, name)))
  return out
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('docker relay init pure helpers', () => {
  it('validates ports and the relayName bound before write', () => {
    expect(validatePort('3030')).toBe(3030)
    expect(validatePort('443')).toBe(443)
    expect(validatePort('80')).toBe(80)
    expect(() => validatePort('0')).toThrow()
    expect(() => validatePort('65536')).toThrow()
    expect(() => validatePort('abc')).toThrow()
    expect(validateRelayName('cherry-relay')).toBe('cherry-relay')
    expect(() => validateRelayName('')).toThrow()
    expect(() => validateRelayName('x'.repeat(129))).toThrow()
  })

  it('validates the optional public URL (http/https only, fail-closed)', () => {
    expect(validatePublicUrl('')).toBeNull()
    expect(validatePublicUrl(undefined as unknown as string)).toBeNull()
    expect(validatePublicUrl('http://192.168.1.50:3044')).toBe('http://192.168.1.50:3044')
    expect(validatePublicUrl('https://relay.example.com:443')).toBe('https://relay.example.com:443')
    expect(() => validatePublicUrl('ftp://192.168.1.50')).toThrow(/http/)
    expect(() => validatePublicUrl('not-a-url')).toThrow()
    expect(() => validatePublicUrl(`http://x/${'y'.repeat(2048)}`)).toThrow(/too long/)
    // Malformed authority forms without an explicit http(s):// prefix fail.
    expect(() => validatePublicUrl('http:example.com')).toThrow(/http/)
    expect(() => validatePublicUrl('http:///example.com')).toThrow()
    // Wildcard/unspecified hosts are never advertised as a public URL.
    expect(() => validatePublicUrl('http://0.0.0.0:3044')).toThrow(/wildcard/)
    expect(() => validatePublicUrl('http://[::]:3044')).toThrow(/wildcard/)
    expect(() => validatePublicUrl('http://::3044')).toThrow()
    expect(isWildcardPublicHostname('0.0.0.0')).toBe(true)
    expect(isWildcardPublicHostname('::')).toBe(true)
    expect(isWildcardPublicHostname('[::]')).toBe(true)
    expect(isWildcardPublicHostname('192.168.1.50')).toBe(false)
    // Credential-bearing URLs must not reach the mode-0644 public config.
    expect(() => validatePublicUrl('http://user:pass@192.168.1.50:3044')).toThrow(/credential/)
    expect(() => validatePublicUrl('http://user@192.168.1.50:3044')).toThrow(/credential/)
    expect(() => validatePublicUrl('https://user:pass@example.com/')).toThrow(/credential/)
  })

  it('canonicalizes uppercase/mixed-case schemes to one lowercase representation', () => {
    // Implementation accepts HTTP(S) scheme casing case-insensitively but
    // persists a single canonical lowercase-scheme form; host/path semantics
    // are preserved and credentials/wildcards still fail closed.
    expect(validatePublicUrl('HTTP://192.168.1.50:3044')).toBe('http://192.168.1.50:3044')
    expect(validatePublicUrl('HtTp://192.168.1.50:3044/sync?x=1')).toBe('http://192.168.1.50:3044/sync?x=1')
    expect(validatePublicUrl('HTTPS://relay.example.com:443/sync')).toBe('https://relay.example.com:443/sync')
    expect(() => validatePublicUrl('HTTP://user:pass@192.168.1.50:3044')).toThrow(/credential/)
    expect(() => validatePublicUrl('HTTP://0.0.0.0:3044')).toThrow(/wildcard/)
    expect(() => validatePublicUrl('HTTPS://[::]:3044')).toThrow(/wildcard/)
    // Persisted artifact carries the canonical form and matches the shipped
    // schema pattern (which itself accepts either casing portably).
    const root = makeRoot()
    try {
      const configPath = join(root, 'relay-config.cherry')
      expect(ensurePublicConfig(configPath, { relayName: 'r', publicUrl: 'HTTP://192.168.1.50:3044' }).created).toBe(
        true
      )
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.publicUrl).toBe('http://192.168.1.50:3044')
      const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
        properties: Record<string, { pattern?: string }>
      }
      const pattern = schema.properties.publicUrl.pattern as string
      expect(new RegExp(pattern).test('HTTP://192.168.1.50:3044')).toBe(true)
      expect(new RegExp(pattern).test('HtTpS://relay.example.com:443')).toBe(true)
      expect(new RegExp(pattern).test(persisted.publicUrl as string)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats blank/whitespace RELAY_TOKEN_FILE as unset (default Compose expansion)', () => {
    const dataDir = join(tmpdir(), 'cherry-relay-token-test')
    expect(resolveTokenFilePath(undefined, dataDir)).toBe(join(dataDir, 'relay-token'))
    expect(resolveTokenFilePath('', dataDir)).toBe(join(dataDir, 'relay-token'))
    expect(resolveTokenFilePath('   ', dataDir)).toBe(join(dataDir, 'relay-token'))
    expect(resolveTokenFilePath(' \t\n ', dataDir)).toBe(join(dataDir, 'relay-token'))
    expect(resolveTokenFilePath(join(dataDir, 'custom-token'), dataDir)).toBe(resolve(join(dataDir, 'custom-token')))
  })

  it('validates TLS passthrough as both-or-neither with readable files', () => {
    const root = makeRoot()
    try {
      expect(validateTlsPassthrough('', '')).toBeNull()
      expect(validateTlsPassthrough(undefined, undefined)).toBeNull()
      const cert = join(root, 'cert.pem')
      const key = join(root, 'key.pem')
      writeFileSync(cert, 'CERT-BODY\n')
      writeFileSync(key, 'KEY-BODY\n')
      expect(validateTlsPassthrough(cert, key)).toEqual({ certFile: cert, keyFile: key })
      expect(() => validateTlsPassthrough(cert, '')).toThrow(/together/)
      expect(() => validateTlsPassthrough('', key)).toThrow(/together/)
      expect(() => validateTlsPassthrough(join(root, 'absent.pem'), key)).toThrow(/cannot read/)
      const empty = join(root, 'empty.pem')
      writeFileSync(empty, '   \n')
      expect(() => validateTlsPassthrough(empty, key)).toThrow(/empty/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds a public config with endpoint metadata only (no secrets)', () => {
    const config = buildPublicConfig({ relayName: 'r', publicUrl: PUBLIC_URL, issuedAt: '2026-09-06T12:00:00Z' })
    expect(config).toMatchObject({ schemaVersion: 2, relayInitVersion: 2, relayName: 'r', publicUrl: PUBLIC_URL })
    const serialized = JSON.stringify(config)
    expect(serialized).not.toMatch(/token|PRIVATE KEY|BEGIN CERTIFICATE|fingerprint/i)
  })

  it('writes tokens atomically with restrictive mode and no temp residue', () => {
    const root = makeRoot()
    try {
      const target = join(root, 'relay-token')
      const first = ensureToken(target)
      expect(first.created).toBe(true)
      expect(first.token.length).toBeGreaterThanOrEqual(64)
      expect(modeOf(target)).toBe(0o600)
      const second = ensureToken(target)
      expect(second.created).toBe(false)
      expect(second.token).toBe(first.token)
      expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])
      writeFileSync(target, '\n')
      expect(() => ensureToken(target)).toThrow(/corrupt/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes files atomically with restrictive mode and no temp residue', () => {
    const root = makeRoot()
    try {
      const target = join(root, 'atomic-check.txt')
      writeFileAtomic(target, 'hello\n', 0o600)
      expect(readFileSync(target, 'utf8')).toBe('hello\n')
      expect(modeOf(target)).toBe(0o600)
      expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects tampered public configs without rewriting them (direct shape)', () => {
    const good = buildPublicConfig({ relayName: 'r', publicUrl: PUBLIC_URL, issuedAt: '2026-09-06T12:00:00Z' })
    expect(() => validatePublicConfigShape(good, PUBLIC_URL)).not.toThrow()
    const cases: Array<{ name: string; mutate: (c: Record<string, unknown>) => void }> = [
      { name: 'extra-token', mutate: (c) => (c.token = 'secret') },
      { name: 'extra-cert', mutate: (c) => (c.caCertificate = 'secret') },
      { name: 'extra-fingerprint', mutate: (c) => (c.caFingerprint = 'secret') },
      { name: 'unknown-prop', mutate: (c) => (c.unexpected = 1) },
      { name: 'bad-url', mutate: (c) => (c.publicUrl = 'ftp://x') },
      { name: 'url-mismatch', mutate: (c) => (c.publicUrl = 'http://192.168.9.9:3044') },
      { name: 'bad-issuedAt', mutate: (c) => (c.issuedAt = 'not-a-date') },
      { name: 'numeric-relayName', mutate: (c) => (c.relayName = 123 as unknown as string) },
      { name: 'date-only-issuedAt', mutate: (c) => (c.issuedAt = '2026-09-06') }
    ]
    for (const tamper of cases) {
      const next = { ...(good as unknown as Record<string, unknown>) }
      tamper.mutate(next)
      expect(() => validatePublicConfigShape(next, PUBLIC_URL), tamper.name).toThrow()
    }
    // ensurePublicConfig rewrites a valid-but-stale URL and preserves issuedAt on reuse.
    const root = makeRoot()
    try {
      const configPath = join(root, 'relay-config.cherry')
      expect(ensurePublicConfig(configPath, { relayName: 'r', publicUrl: PUBLIC_URL }).created).toBe(true)
      const before = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      expect(ensurePublicConfig(configPath, { relayName: 'r', publicUrl: PUBLIC_URL }).reused).toBe(true)
      const after = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      expect(after.issuedAt).toBe(before.issuedAt)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('issuedAt rejects impossible calendar dates and accepts valid RFC3339 variants', () => {
    for (const valid of [
      '2026-09-06T12:00:00Z',
      '2026-09-06T12:00:00.123Z',
      '2026-09-06T12:00:00+08:00',
      '2024-02-29T12:00:00Z'
    ]) {
      expect(isValidIssuedAt(valid), valid).toBe(true)
    }
    for (const invalid of [
      '2026-02-30T12:00:00Z',
      '2026-04-31T12:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-09-06',
      '2026-09-06T12:00:00',
      'not-a-date',
      123 as unknown as string
    ]) {
      expect(isValidIssuedAt(invalid), String(invalid)).toBe(false)
    }
  })
})

describe('docker relay first-start init (bounded subprocess)', () => {
  it('creates token + DB with safe modes and safe logs, and no certificate artifacts', () => {
    const root = makeRoot()
    try {
      const run = runInit(root)
      expect(run.status).toBe(0)
      expect(existsSync(join(root, 'relay-token'))).toBe(true)
      expect(existsSync(join(root, 'relay.db'))).toBe(true)
      // No public config without RELAY_PUBLIC_URL; no certificate material ever.
      expect(existsSync(join(root, 'relay-config.cherry'))).toBe(false)
      for (const name of ['ca-cert.pem', 'ca-key.pem', 'server-cert.pem', 'server-key.pem', 'ca-cert', 'server-cert']) {
        expect(existsSync(join(root, name)), name).toBe(false)
      }
      expect(readdirSync(root).some((n) => n.endsWith('.pem'))).toBe(false)
      expect(modeOf(join(root, 'relay-token'))).toBe(0o600)
      expect(modeOf(join(root, 'relay.db'))).toBe(0o600)
      expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([])

      const token = readFileSync(join(root, 'relay-token'), 'utf8').trim()
      expect(token.length).toBeGreaterThanOrEqual(64)

      // Safe logs only: token-file path, db path, status; never the token.
      expect(run.stdout).toContain('relay-token')
      expect(run.stdout).toContain('relay.db')
      expect(run.stdout).not.toContain(token)
      expect(run.stdout).not.toContain('PRIVATE KEY')
      expect(run.stdout).not.toContain('CERTIFICATE')
      expect(run.stdout).not.toContain('fingerprint')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('initializes with default Compose empty RELAY_TOKEN_FILE (no env override required)', () => {
    for (const tokenOverride of ['', '   ']) {
      const root = makeRoot()
      try {
        // Default Compose sets `RELAY_TOKEN_FILE: ${RELAY_TOKEN_FILE:-}` which
        // expands to an empty string when the operator sets nothing. Init
        // must treat it as unset and create `<dataDir>/relay-token`.
        const run = runInit(root, { RELAY_TOKEN_FILE: tokenOverride })
        expect(run.status).toBe(0)
        expect(existsSync(join(root, 'relay-token'))).toBe(true)
        expect(existsSync(join(root, 'relay.db'))).toBe(true)
        expect(modeOf(join(root, 'relay-token'))).toBe(0o600)
        const token = readFileSync(join(root, 'relay-token'), 'utf8').trim()
        expect(token.length).toBeGreaterThanOrEqual(64)
        expect(run.stdout).toContain('relay-token')
        expect(run.stdout).not.toContain(token)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('writes a metadata-only public config when RELAY_PUBLIC_URL is set', () => {
    const root = makeRoot()
    try {
      const run = runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL })
      expect(run.status).toBe(0)
      expect(existsSync(join(root, 'relay-config.cherry'))).toBe(true)
      expect(modeOf(join(root, 'relay-config.cherry'))).toBe(0o644)
      const config = JSON.parse(readFileSync(join(root, 'relay-config.cherry'), 'utf8')) as Record<string, unknown>
      expect(config.schemaVersion).toBe(2)
      expect(config.publicUrl).toBe(PUBLIC_URL)
      expect(config.relayName).toBe('test-relay')
      const serialized = JSON.stringify(config)
      expect(serialized).not.toContain(readFileSync(join(root, 'relay-token'), 'utf8').trim())
      expect(serialized).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|fingerprint/i)
      expect(run.stdout).toContain(PUBLIC_URL)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reuses byte-identical artifacts on second init (with and without public URL)', () => {
    for (const withUrl of [false, true]) {
      const root = makeRoot()
      try {
        const firstArgs = withUrl ? { RELAY_PUBLIC_URL: PUBLIC_URL } : {}
        expect(runInit(root, firstArgs).status).toBe(0)
        const before = snapshotFiles(root)
        const second = runInit(root, firstArgs)
        expect(second.status).toBe(0)
        expect(second.stdout).toContain('reuse')
        const after = snapshotFiles(root)
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
        for (const [name, hash] of before) expect(after.get(name), name).toBe(hash)
        expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('fails closed on corrupt token without replacing it', () => {
    const root = makeRoot()
    try {
      expect(runInit(root).status).toBe(0)
      const tokenPath = join(root, 'relay-token')
      const before = snapshotFiles(root)
      writeFileSync(tokenPath, '\n')
      const run = runInit(root)
      expect(run.status).not.toBe(0)
      for (const [name, hash] of before) {
        if (name === 'relay-token') continue
        expect(sha256Of(join(root, name)), name).toBe(hash)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed on tampered public config without rewriting it', () => {
    const root = makeRoot()
    try {
      expect(runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL }).status).toBe(0)
      const configPath = join(root, 'relay-config.cherry')
      const pristine = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      const before = snapshotFiles(root)
      const tamperCases: Array<{ name: string; mutate: (c: Record<string, unknown>) => void }> = [
        { name: 'extra-token', mutate: (c) => (c.token = 'secret') },
        { name: 'extra-cert', mutate: (c) => (c.caCertificate = 'secret') },
        { name: 'unknown-prop', mutate: (c) => (c.unexpected = 1) },
        { name: 'bad-issuedAt', mutate: (c) => (c.issuedAt = 'not-a-date') },
        { name: 'url-mismatch', mutate: (c) => (c.publicUrl = 'http://192.168.9.9:3044') }
      ]
      for (const tamper of tamperCases) {
        const next = { ...pristine }
        tamper.mutate(next)
        writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`)
        const tamperedHash = sha256Of(configPath)
        const run = runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL })
        expect(run.status, tamper.name).not.toBe(0)
        expect(sha256Of(configPath), `${tamper.name}:config`).toBe(tamperedHash)
        for (const [name, hash] of before) {
          if (name === 'relay-config.cherry') continue
          expect(sha256Of(join(root, name)), `${tamper.name}:${name}`).toBe(hash)
        }
        writeFileSync(configPath, `${JSON.stringify(pristine, null, 2)}\n`)
        expect(runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL }).status).toBe(0)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects legacy RELAY_LAN_IP before any mutation', () => {
    const root = makeRoot()
    try {
      const run = runInit(root, { RELAY_LAN_IP: '192.168.1.50' })
      expect(run.status).not.toBe(0)
      expect(`${run.stdout}${run.stderr}`).toMatch(/RELAY_LAN_IP is no longer supported/)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid RELAY_PUBLIC_URL before any mutation', () => {
    const root = makeRoot()
    try {
      const run = runInit(root, { RELAY_PUBLIC_URL: 'ftp://192.168.1.50' })
      expect(run.status).not.toBe(0)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects wildcard and credential-bearing RELAY_PUBLIC_URL before any mutation', () => {
    for (const bad of [
      'http://0.0.0.0:3044',
      'http://[::]:3044',
      'http://user:pass@192.168.1.50:3044',
      'http://user@192.168.1.50:3044',
      'https://user:pass@example.com/',
      'http:example.com',
      'http:///example.com'
    ]) {
      const root = makeRoot()
      try {
        const run = runInit(root, { RELAY_PUBLIC_URL: bad })
        expect(run.status, bad).not.toBe(0)
        expect(readdirSync(root), bad).toEqual([])
        expect(`${run.stdout}${run.stderr}`, bad).toMatch(/invalid RELAY_PUBLIC_URL/)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
    // No credential-bearing URL ever reaches the public config artifact.
    const root = makeRoot()
    try {
      expect(runInit(root, { RELAY_PUBLIC_URL: 'http://user:pass@192.168.1.50:3044' }).status).not.toBe(0)
      expect(existsSync(join(root, 'relay-config.cherry'))).toBe(false)
      expect(runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL }).status).toBe(0)
      const serialized = readFileSync(join(root, 'relay-config.cherry'), 'utf8')
      expect(serialized).not.toContain('user')
      expect(serialized).not.toContain('pass')
      expect(serialized).not.toContain('@')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('public config matches the shipped schema (no cert/fingerprint fields)', () => {
    const root = makeRoot()
    try {
      expect(runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL }).status).toBe(0)
      const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
        properties: Record<string, unknown>
        required: string[]
      }
      const config = JSON.parse(readFileSync(join(root, 'relay-config.cherry'), 'utf8')) as Record<string, unknown>
      for (const key of schema.required) expect(config[key]).toBeDefined()
      expect(config.schemaVersion).toBe(2)
      expect(config.publicUrl).toBe(PUBLIC_URL)
      expect('caCertificate' in config).toBe(false)
      expect('caFingerprint' in config).toBe(false)
      expect('lanIp' in config).toBe(false)
      expect('endpoint' in config).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('docker relay deployment structure (no daemon required)', () => {
  it('Dockerfile targets pinned multi-arch Node with narrow relay payload and no OpenSSL', () => {
    const content = readFileSync(DOCKERFILE, 'utf8')
    expect(content).toContain('FROM node:24.11.1-bookworm')
    expect(content).toContain('pnpm@10.27.0')
    expect(content).toContain('scripts/sync-relay')
    expect(content).toContain('packages/shared')
    expect(content).toContain('docker-entrypoint.sh')
    expect(content).not.toContain('openssl')
    // The only 0.0.0.0 mention is the bridge-networking comment; the image
    // itself never binds (the entrypoint owns the container-internal bind).
    expect(content).not.toContain('--host')
    expect(content).not.toMatch(/RELAY_LAN_IP/)
    const manifest = JSON.parse(readFileSync(IMAGE_MANIFEST, 'utf8')) as { dependencies?: Record<string, string> }
    expect(manifest.dependencies?.['better-sqlite3']).toBe('12.11.1')
    expect(manifest.dependencies?.['tsx']).toBe('4.20.3')
  })

  it('image install is reproducible with build-script approval and a frozen lockfile', () => {
    const manifest = JSON.parse(readFileSync(IMAGE_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>
      pnpm?: { onlyBuiltDependencies?: string[] }
    }
    expect(manifest.pnpm?.onlyBuiltDependencies).toContain('better-sqlite3')
    expect(manifest.pnpm?.onlyBuiltDependencies).toContain('esbuild')
    expect(existsSync(IMAGE_LOCKFILE)).toBe(true)
    const lock = readFileSync(IMAGE_LOCKFILE, 'utf8')
    expect(lock).toContain('better-sqlite3')
    expect(lock).toContain('tsx')
    expect(lock).toMatch(/version:\s*12\.11\.1/)
    expect(lock).toMatch(/version:\s*4\.20\.3/)
    const docker = readFileSync(DOCKERFILE, 'utf8')
    expect(docker).toContain('pnpm-lock.yaml')
    expect(docker).toContain('--frozen-lockfile')
    expect(docker).toContain('--prod')
    expect(docker).not.toContain('pnpm install --prod\n')
  })

  it('root build context excludes secrets and state but no certificate-only entries', () => {
    expect(existsSync(DOCKERIGNORE)).toBe(true)
    const ignore = readFileSync(DOCKERIGNORE, 'utf8')
    for (const required of ['relay-data', 'node_modules', '.git/', 'relay-token', '.env', 'test-results/']) {
      expect(ignore, required).toContain(required)
    }
    // No relay-owned certificate artifacts exist anymore.
    expect(ignore).not.toContain('ca-key.pem')
    expect(ignore).not.toContain('ca-cert.pem')
    expect(ignore).not.toContain('server-key.pem')
    expect(ignore).not.toContain('server-cert.pem')
    const docker = readFileSync(DOCKERFILE, 'utf8')
    expect(docker).not.toContain('COPY . ')
  })

  it('public config schema carries endpoint metadata only', () => {
    const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as {
      properties: Record<string, { pattern?: string; maxLength?: number }>
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.publicUrl.pattern).toContain('[Hh][Tt][Tt][Pp]')
    expect(schema.properties.relayName.maxLength).toBe(128)
    expect(schema.required).toEqual(
      expect.arrayContaining(['schemaVersion', 'relayInitVersion', 'relayName', 'publicUrl', 'issuedAt'])
    )
    expect(Object.keys(schema.properties)).not.toContain('caCertificate')
    expect(Object.keys(schema.properties)).not.toContain('caFingerprint')
    expect(Object.keys(schema.properties)).not.toContain('lanIp')
    expect(Object.keys(schema.properties)).not.toContain('endpoint')
    const root = makeRoot()
    try {
      expect(runInit(root, { RELAY_PUBLIC_URL: PUBLIC_URL }).status).toBe(0)
      const config = JSON.parse(readFileSync(join(root, 'relay-config.cherry'), 'utf8')) as Record<string, unknown>
      expect(new RegExp(schema.properties.publicUrl.pattern as string).test(config.publicUrl as string)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('compose uses standard bridge networking with ports (no host network, no LAN IP)', () => {
    const content = readFileSync(COMPOSE, 'utf8')
    expect(content).toContain('ports:')
    expect(content).toMatch(/\$\{RELAY_PORT:-3030\}:3030/)
    expect(content).toContain('relay-data:/data')
    expect(content).toContain('dockerfile: deploy/sync-relay/Dockerfile')
    expect(content).not.toContain('network_mode')
    expect(content).not.toContain('RELAY_LAN_IP')
  })

  it('entrypoint binds the container-internal address and execs the unchanged relay CLI', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8')
    expect(content).toContain('uname -s')
    expect(content).toContain('umask 077')
    expect(content).toContain('relay-init.mjs')
    expect(content).toContain('SYNC_RELAY_TOKEN')
    expect(content).toContain('scripts/sync-relay/server.ts')
    expect(content).toContain('--host 0.0.0.0')
    expect(content).toContain('--allow-unspecified-bind')
    // PID 1 is the relay server itself: direct Node/tsx CLI execution with
    // no npx/npm wrapper between PID 1 and the relay (clean SIGTERM exit).
    expect(content).toContain('exec node /app/node_modules/tsx/dist/cli.mjs /app/scripts/sync-relay/server.ts')
    expect(content).not.toContain('exec npx')
    expect(content).not.toContain('exec npm')
    expect(content).not.toMatch(/\bnpx\s+tsx\b/)
    // Blank/whitespace token file is treated as unset (default Compose empty).
    expect(content).toContain('RELAY_TOKEN_TRIMMED')
    expect(content).toContain('unset RELAY_TOKEN_FILE')
    // Internal bridge attestation set only here after init/token validation.
    expect(content).toContain("CHERRY_RELAY_BRIDGE_BIND='docker-bridge-v1'")
    expect(content).toMatch(/^exec /m)
    expect(content).not.toContain('eval')
    // Legacy RELAY_LAN_IP appears only to fail fast on stale Compose files.
    expect(content).toMatch(/RELAY_LAN_IP is no longer supported/)
    expect(content).not.toContain('openssl')
    const syntax = spawnSync('sh', ['-n', ENTRYPOINT], { encoding: 'utf8' })
    expect(syntax.status).toBe(0)
  })
})
