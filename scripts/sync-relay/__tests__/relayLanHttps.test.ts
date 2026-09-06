/**
 * Focused LAN transport contract for the personal sync relay.
 *
 * Covers both supported non-loopback transports (explicit product boundary):
 * - Plain HTTP is an explicit supported transport for explicit numeric
 *   non-loopback hosts (unencrypted — the client shows a visible warning).
 * - Native HTTPS stays supported with user-supplied --cert/--key (generic
 *   cert/key support; the relay never generates certificates).
 * - Missing/empty/mismatched cert/key fails before the DB is created.
 * - The container-internal 0.0.0.0/:: bind requires
 *   --allow-unspecified-bind and is never a user-facing endpoint.
 * - Native HTTPS readiness/health works with a disposable cert/key;
 * - loopback plain HTTP still works without cert/key (regression).
 *
 * Trust is explicit only: TLS clients verify with the disposable `ca`
 * material (never `rejectUnauthorized:false`). All cert/key artifacts live
 * under test-owned temp roots and are removed after proven child exit.
 * The runner imports `better-sqlite3` only through the already-imported
 * relay server module (same as relayUserEntrypoint.test.ts); spawned relay
 * children own their SQLite binding under the pinned Node/tsx runtime.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { networkInterfaces } from 'node:os'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  createRelayServer,
  formatRelayHostForUrl,
  formatRelayReadiness,
  hasZoneSuffix,
  isBridgeBindAttested,
  isNumericIpHost,
  isWildcardHost,
  normalizeRelayBindHost,
  parseRelayArgs,
  RELAY_BRIDGE_ATTEST_ENV,
  RELAY_BRIDGE_ATTEST_VALUE,
  resolveRelayTls
} from '../server'

const SERVER_ENTRY = resolve(process.cwd(), 'scripts/sync-relay/server.ts')
const TSX_ENTRY = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const TOKEN = 'lan-https-token-1'
const START_TIMEOUT_MS = 20000
const STOP_TIMEOUT_MS = 8000
const REQUEST_TIMEOUT_MS = 5000

function discoverLanIpv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && a.address !== '127.0.0.1') return a.address
    }
  }
  return null
}

const LAN_IP = discoverLanIpv4()

function openssl(args: string[], cwd: string): void {
  const res = spawnSync('openssl', args, { cwd, timeout: 30000, encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`openssl ${args.slice(0, 3).join(' ')} failed: ${String(res.stderr).slice(0, 300)}`)
  }
}

/** Disposable self-signed server cert with SAN IP:<host>; client trusts via ca=cert. */
function generateServerCert(root: string, host: string, name: string): { certPath: string; keyPath: string } {
  const keyPath = join(root, `${name}.key.pem`)
  const certPath = join(root, `${name}.cert.pem`)
  openssl(
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-nodes',
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=IP:${host}`
    ],
    root
  )
  return { certPath, keyPath }
}

function httpsHealth(url: string, caPath: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpsGet(url, { ca: readFileSync(caPath), timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = ''
      res.on('data', (c: Buffer) => {
        data += c.toString('utf8')
      })
      res.on('end', () => {
        try {
          resolvePromise({ status: res.statusCode ?? 0, body: JSON.parse(data) })
        } catch (e) {
          rejectPromise(e)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('https health timeout')))
    req.on('error', rejectPromise)
  })
}

function waitExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not exit')), ms)
    t.unref?.()
    child.once('exit', () => {
      clearTimeout(t)
      res()
    })
  })
}

describe('relay LAN HTTPS TLS config (fail-closed, before DB)', () => {
  it('loopback without cert/key stays plain HTTP', () => {
    expect(resolveRelayTls('127.0.0.1').scheme).toBe('http')
    expect(resolveRelayTls('localhost').scheme).toBe('http')
  })

  it('non-loopback without cert/key serves plain HTTP (explicit supported transport)', () => {
    expect(resolveRelayTls('192.168.1.10').scheme).toBe('http')
    expect(resolveRelayTls('192.168.1.10', undefined, undefined).scheme).toBe('http')
    expect(parseRelayArgs(['--host', '192.168.1.10'], {}).host).toBe('192.168.1.10')
  })

  it('container-internal unspecified bind requires deployment attestation (flag + marker + container)', () => {
    expect(() => resolveRelayTls('0.0.0.0')).toThrow(/wildcard.*forbidden/)
    expect(() => resolveRelayTls('0.0.0.0', undefined, undefined, { allowUnspecifiedBind: false })).toThrow(
      /wildcard.*forbidden/
    )
    // Flag without attestation fails (direct host escape closed).
    expect(() => resolveRelayTls('0.0.0.0', undefined, undefined, { allowUnspecifiedBind: true })).toThrow(
      /allow-unspecified-bind.*deployment-scoped/
    )
    expect(() => parseRelayArgs(['--host', '0.0.0.0', '--allow-unspecified-bind'], {})).toThrow(
      /allow-unspecified-bind.*deployment-scoped/
    )
    expect(() => parseRelayArgs(['--host', '0.0.0.0'], {})).toThrow(/wildcard/)
    // Attested Docker-bridge path (internal marker + container indicator).
    const attestedEnv = { [RELAY_BRIDGE_ATTEST_ENV]: RELAY_BRIDGE_ATTEST_VALUE } as NodeJS.ProcessEnv
    const containerExists = (p: string): boolean => p === '/.dockerenv'
    expect(isBridgeBindAttested(attestedEnv, containerExists)).toBe(true)
    expect(isBridgeBindAttested(attestedEnv, () => false)).toBe(false)
    expect(
      resolveRelayTls('0.0.0.0', undefined, undefined, {
        allowUnspecifiedBind: true,
        env: attestedEnv,
        bridgeExists: containerExists
      }).scheme
    ).toBe('http')
    expect(parseRelayArgs(['--host', '0.0.0.0', '--allow-unspecified-bind'], attestedEnv, containerExists).host).toBe(
      '0.0.0.0'
    )
    expect(parseRelayArgs(['--host', '::', '--allow-unspecified-bind'], attestedEnv, containerExists).host).toBe('::')
  })

  it('internal unspecified readiness is non-URL while explicit hosts stay URL-shaped', () => {
    expect(formatRelayReadiness('0.0.0.0', 'http', 3030)).toBe(
      '[sync-relay] listening on http (internal bind) port 3030'
    )
    expect(formatRelayReadiness('::', 'http', 3030)).toBe('[sync-relay] listening on http (internal bind) port 3030')
    expect(formatRelayReadiness('0.0.0.0', 'http', 3030)).not.toContain('http://')
    expect(formatRelayReadiness('::', 'http', 3030)).not.toContain('http://')
    expect(formatRelayReadiness('192.168.1.10', 'http', 3030)).toBe(
      '[sync-relay] listening on http://192.168.1.10:3030'
    )
    expect(formatRelayReadiness('192.168.1.10', 'https', 3030)).toBe(
      '[sync-relay] listening on https://192.168.1.10:3030'
    )
  })

  it('wildcard/all-interface binds are forbidden even before cert checks', () => {
    for (const wild of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '0::', '::0', '0::0', '*']) {
      expect(isWildcardHost(wild)).toBe(true)
      expect(() => resolveRelayTls(wild)).toThrow(/wildcard.*forbidden/)
      expect(() => parseRelayArgs(['--host', wild], {})).toThrow(/wildcard/)
    }
    // IPv4-mapped unspecified forms Node binds as `::`: every
    // compressed/expanded/hex/case/bracketed representation must fail before
    // cert checks and before the DB is opened.
    for (const wild of [
      '::ffff:0.0.0.0',
      '::FFFF:0.0.0.0',
      '0:0:0:0:0:ffff:0.0.0.0',
      '0:0:0:0:0:FFFF:0.0.0.0',
      '::ffff:0:0',
      '0:0:0:0:0:ffff:0:0',
      '0::ffff:0.0.0.0',
      '[::ffff:0.0.0.0]',
      '[0:0:0:0:0:ffff:0.0.0.0]',
      '::0.0.0.0'
    ]) {
      expect(isWildcardHost(wild)).toBe(true)
      expect(() => resolveRelayTls(wild)).toThrow(/wildcard.*forbidden/)
      expect(() => parseRelayArgs(['--host', wild], {})).toThrow(/wildcard/)
    }
    // Zone-suffixed wildcard representations Node treats as wildcard.
    for (const wild of ['::%eth0', '[::%eth0]', '[::]%eth0', '::ffff:0.0.0.0%eth0', '[::ffff:0.0.0.0%eth0]']) {
      expect(isWildcardHost(wild)).toBe(true)
      expect(() => parseRelayArgs(['--host', wild], {})).toThrow(/wildcard/)
    }
    expect(isWildcardHost('192.168.1.10')).toBe(false)
    expect(isWildcardHost('127.0.0.1')).toBe(false)
    expect(isWildcardHost('::1')).toBe(false)
    expect(isWildcardHost('fe80::1')).toBe(false)
    expect(isWildcardHost('::ffff:192.168.1.10')).toBe(false)
    expect(isNumericIpHost('192.168.1.10')).toBe(true)
    expect(isNumericIpHost('::1')).toBe(true)
    expect(isNumericIpHost('lan-host')).toBe(false)
    expect(() => resolveRelayTls('lan-host')).toThrow(/explicit numeric/)
    expect(() => parseRelayArgs(['--host', 'lan-host'], {})).toThrow(/explicit numeric/)
  })

  it('zone-scoped IPv6 literals are rejected explicitly (no ambiguous URL)', () => {
    expect(hasZoneSuffix('fe80::1%eth0')).toBe(true)
    expect(hasZoneSuffix('[fe80::1%eth0]')).toBe(true)
    expect(hasZoneSuffix('fe80::1')).toBe(false)
    expect(hasZoneSuffix('192.168.1.10')).toBe(false)
    expect(hasZoneSuffix('127.0.0.1')).toBe(false)
    for (const zoned of ['fe80::1%eth0', '[fe80::1%eth0]']) {
      expect(() => parseRelayArgs(['--host', zoned], {})).toThrow(/zone/)
      expect(() => resolveRelayTls(zoned)).toThrow(/zone/)
    }
  })

  it('IPv6 URL serialization brackets literals; explicit IPv6 validates to HTTPS', () => {
    expect(formatRelayHostForUrl('192.168.1.10')).toBe('192.168.1.10')
    expect(formatRelayHostForUrl('127.0.0.1')).toBe('127.0.0.1')
    expect(formatRelayHostForUrl('::1')).toBe('[::1]')
    expect(formatRelayHostForUrl('fe80::1')).toBe('[fe80::1]')
    expect(formatRelayHostForUrl('[::1]')).toBe('[::1]')
    expect(formatRelayHostForUrl('::ffff:192.168.1.10')).toBe('[::ffff:192.168.1.10]')
    // Bracketed readiness/endpoint forms parse as valid URLs with a port.
    for (const v6 of ['::1', 'fe80::1']) {
      const url = new URL(`https://${formatRelayHostForUrl(v6)}:3030/health`)
      expect(url.hostname.replace(/^\[|\]$/g, '')).toContain(':')
      expect(url.port).toBe('3030')
    }
    // A real explicit IPv6 loopback form passes validation and resolves to
    // native HTTPS with a matched cert/key pair (no bind, so no platform
    // interface dependency).
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-v6-accept-'))
    try {
      const { certPath, keyPath } = generateServerCert(root, '127.0.0.1', 'v6accept')
      expect(isWildcardHost('::1')).toBe(false)
      expect(isNumericIpHost('::1')).toBe(true)
      expect(parseRelayArgs(['--host', '::1'], {}).host).toBe('::1')
      expect(resolveRelayTls('::1', certPath, keyPath).scheme).toBe('https')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bracketed IPv6 bind inputs normalize to raw hosts for server.listen (URL keeps brackets)', () => {
    // Normalization is deterministic parse-only: no live non-loopback IPv6
    // bind is claimed here, only that accepted hosts are stored raw so
    // `server.listen()` never receives URL bracket syntax.
    expect(normalizeRelayBindHost('[::1]')).toBe('::1')
    expect(normalizeRelayBindHost('[fe80::1]')).toBe('fe80::1')
    expect(normalizeRelayBindHost('::1')).toBe('::1')
    expect(normalizeRelayBindHost('fe80::1')).toBe('fe80::1')
    expect(normalizeRelayBindHost('192.168.1.10')).toBe('192.168.1.10')
    expect(normalizeRelayBindHost('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeRelayBindHost('localhost')).toBe('localhost')
    // Bracketed loopback IPv4 normalizes to the loopback contract.
    expect(normalizeRelayBindHost('[127.0.0.1]')).toBe('127.0.0.1')
    // CLI storage is raw (no brackets) for both bracketed and unbracketed forms.
    expect(parseRelayArgs(['--host', '[::1]'], {}).host).toBe('::1')
    expect(parseRelayArgs(['--host', '::1'], {}).host).toBe('::1')
    expect(parseRelayArgs(['--host', '[fe80::1]'], {}).host).toBe('fe80::1')
    expect(parseRelayArgs(['--host', 'fe80::1'], {}).host).toBe('fe80::1')
    expect(parseRelayArgs(['--host', '192.168.1.10'], {}).host).toBe('192.168.1.10')
    expect(parseRelayArgs(['--host', '[127.0.0.1]'], {}).host).toBe('127.0.0.1')
    for (const h of ['[::1]', '[fe80::1]', '::1', 'fe80::1', '192.168.1.10']) {
      expect(parseRelayArgs(['--host', h], {}).host.includes('[')).toBe(false)
    }
    // URL/readiness serialization keeps brackets for the same raw hosts.
    expect(formatRelayHostForUrl(parseRelayArgs(['--host', '[::1]'], {}).host)).toBe('[::1]')
    expect(formatRelayHostForUrl(parseRelayArgs(['--host', '::1'], {}).host)).toBe('[::1]')
    // Malformed bracket forms are rejected (fail-closed, no bind).
    for (const bad of ['[::1', '[::1]extra', '[]', '[[::1]]', '[::1]]']) {
      expect(() => parseRelayArgs(['--host', bad], {})).toThrow(/invalid --host/)
    }
    // Existing wildcard/zone policy is preserved for bracketed forms.
    expect(() => parseRelayArgs(['--host', '[::]'], {})).toThrow(/wildcard/)
    expect(() => parseRelayArgs(['--host', '[fe80::1%eth0]'], {})).toThrow(/zone/)
    expect(() => parseRelayArgs(['--host', '[::]%eth0'], {})).toThrow(/wildcard/)
  })

  it('wildcard binds fail even with valid cert/key (before DB creation)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-tls-wild-'))
    try {
      const { certPath, keyPath } = generateServerCert(root, '127.0.0.1', 'wild')
      for (const wild of ['0.0.0.0', '::', '*']) {
        expect(() => resolveRelayTls(wild, certPath, keyPath)).toThrow(/wildcard.*forbidden/)
      }
      // Valid explicit LAN IP with matched cert/key resolves to https.
      const lan = generateServerCert(root, '192.168.1.10', 'explicit-lan')
      expect(resolveRelayTls('192.168.1.10', lan.certPath, lan.keyPath).scheme).toBe('https')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('partial TLS config is rejected on any host', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-tls-'))
    try {
      const { certPath } = generateServerCert(root, '127.0.0.1', 'partial')
      expect(() => resolveRelayTls('127.0.0.1', certPath, undefined)).toThrow(/both --cert and --key/)
      expect(() => resolveRelayTls('192.168.1.10', certPath, undefined)).toThrow(/both --cert and --key/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('missing cert/key files fail before any DB work', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-tls-'))
    try {
      expect(() => resolveRelayTls('192.168.1.10', join(root, 'no-cert.pem'), join(root, 'no-key.pem'))).toThrow(
        /cannot read --cert/
      )
      const { certPath } = generateServerCert(root, '127.0.0.1', 'missing-key')
      expect(() => resolveRelayTls('192.168.1.10', certPath, join(root, 'no-key.pem'))).toThrow(/cannot read --key/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('empty cert/key files are rejected', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-tls-'))
    try {
      const emptyCert = join(root, 'empty.cert.pem')
      const emptyKey = join(root, 'empty.key.pem')
      writeFileSync(emptyCert, '')
      const { keyPath } = generateServerCert(root, '127.0.0.1', 'nonempty')
      expect(() => resolveRelayTls('192.168.1.10', emptyCert, keyPath)).toThrow(/--cert.*empty/)
      writeFileSync(emptyKey, '')
      const { certPath } = generateServerCert(root, '127.0.0.1', 'nonempty2')
      expect(() => resolveRelayTls('192.168.1.10', certPath, emptyKey)).toThrow(/--key.*empty/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('mismatched certificate/key fails before DB creation', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-tls-'))
    try {
      const a = generateServerCert(root, '127.0.0.1', 'a')
      const b = generateServerCert(root, '127.0.0.1', 'b')
      expect(() => resolveRelayTls('192.168.1.10', a.certPath, b.keyPath)).toThrow(/mismatched/)
      // Sanity: matched pairs resolve to https.
      expect(resolveRelayTls('192.168.1.10', a.certPath, a.keyPath).scheme).toBe('https')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('CLI rejects bad TLS and wildcard binds before creating the DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-tls-cli-'))
    try {
      const cases: { args: string[]; match: RegExp }[] = [
        {
          args: ['--host', '0.0.0.0', '--db', join(root, 'c-wild.db'), '--token', TOKEN],
          match: /wildcard/
        },
        {
          args: ['--host', '::', '--db', join(root, 'c-wild6.db'), '--token', TOKEN],
          match: /wildcard/
        },
        {
          args: [
            '--host',
            '192.168.1.10',
            '--db',
            join(root, 'c2.db'),
            '--token',
            TOKEN,
            '--cert',
            join(root, 'absent.pem'),
            '--key',
            join(root, 'absent-key.pem')
          ],
          match: /cannot read --cert/
        }
      ]
      // Mismatched pair case uses disposable generated material.
      const a = generateServerCert(root, '127.0.0.1', 'cli-a')
      const b = generateServerCert(root, '127.0.0.1', 'cli-b')
      cases.push({
        args: [
          '--host',
          '192.168.1.10',
          '--db',
          join(root, 'c3.db'),
          '--token',
          TOKEN,
          '--cert',
          a.certPath,
          '--key',
          b.keyPath
        ],
        match: /mismatched/
      })
      // Partial (cert without key) case.
      cases.push({
        args: ['--host', '192.168.1.10', '--db', join(root, 'c4.db'), '--token', TOKEN, '--cert', a.certPath],
        match: /both --cert and --key/
      })
      // Wildcard with valid cert/key must still fail before DB creation.
      cases.push({
        args: [
          '--host',
          '0.0.0.0',
          '--db',
          join(root, 'c-wild-tls.db'),
          '--token',
          TOKEN,
          '--cert',
          a.certPath,
          '--key',
          a.keyPath
        ],
        match: /wildcard/
      })
      // IPv4-mapped unspecified with valid cert/key must still fail before DB.
      cases.push({
        args: [
          '--host',
          '::ffff:0.0.0.0',
          '--db',
          join(root, 'c-wild-mapped-tls.db'),
          '--token',
          TOKEN,
          '--cert',
          a.certPath,
          '--key',
          a.keyPath
        ],
        match: /wildcard/
      })
      for (const c of cases) {
        const res = spawnSync(process.execPath, [TSX_ENTRY, SERVER_ENTRY, ...c.args], {
          timeout: 30000,
          encoding: 'utf8'
        })
        expect(res.status).toBe(2)
        expect(`${String(res.stderr)}${String(res.stdout)}`).toMatch(c.match)
      }
      for (const f of ['c2.db', 'c3.db', 'c4.db', 'c-wild.db', 'c-wild6.db', 'c-wild-tls.db', 'c-wild-mapped-tls.db']) {
        expect(existsSync(join(root, f))).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 90000)
})

describe('relay native HTTPS serving (disposable cert/key)', () => {
  it('HTTPS health works with explicit CA trust; plaintext to the TLS port fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-https-'))
    const db = new Database(':memory:')
    let server: ReturnType<typeof createRelayServer> | undefined
    try {
      const { certPath, keyPath } = generateServerCert(root, '127.0.0.1', 'srv')
      const tls = resolveRelayTls('127.0.0.1', certPath, keyPath)
      expect(tls.scheme).toBe('https')
      server = createRelayServer(db, {
        token: TOKEN,
        tls: { cert: tls.cert as Buffer, key: tls.key as Buffer }
      })
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        server!.listen(0, '127.0.0.1', () => {
          const addr = server!.address()
          if (typeof addr === 'object' && addr) resolvePort(addr.port)
          else rejectPort(new Error('no bound port'))
        })
        server!.on('error', rejectPort)
      })
      const health = await httpsHealth(`https://127.0.0.1:${port}/health`, certPath)
      expect(health.status).toBe(200)
      expect((health.body as { ok?: unknown }).ok).toBe(true)
      // Plaintext HTTP against the TLS port must fail (no plaintext fallback).
      await expect(
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      ).rejects.toThrow()
    } finally {
      try {
        await new Promise<void>((res) => server?.close(() => res()) ?? res())
      } catch {}
      try {
        db.close()
      } catch {}
      rmSync(root, { recursive: true, force: true })
    }
  }, 60000)

  it('container-internal bridge bind serves plain HTTP without cert/key (deployment attestation)', async () => {
    const db = new Database(':memory:')
    let server: ReturnType<typeof createRelayServer> | undefined
    try {
      // Exact Docker bridge transport: 0.0.0.0 is container-internal only
      // (never a user-facing endpoint); health is reached via loopback.
      // Direct flag use without attestation fails; the attested entrypoint
      // path resolves to plain HTTP.
      expect(() => resolveRelayTls('0.0.0.0', undefined, undefined, { allowUnspecifiedBind: true })).toThrow(
        /allow-unspecified-bind.*deployment-scoped/
      )
      const attestedEnv = { [RELAY_BRIDGE_ATTEST_ENV]: RELAY_BRIDGE_ATTEST_VALUE } as NodeJS.ProcessEnv
      const containerExists = (p: string): boolean => p === '/.dockerenv'
      expect(
        resolveRelayTls('0.0.0.0', undefined, undefined, {
          allowUnspecifiedBind: true,
          env: attestedEnv,
          bridgeExists: containerExists
        }).scheme
      ).toBe('http')
      server = createRelayServer(db, { token: TOKEN })
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        server!.listen(0, '0.0.0.0', () => {
          const addr = server!.address()
          if (typeof addr === 'object' && addr) resolvePort(addr.port)
          else rejectPort(new Error('no bound port'))
        })
        server!.on('error', rejectPort)
      })
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { ok?: unknown }).ok).toBe(true)
    } finally {
      try {
        await new Promise<void>((res) => server?.close(() => res()) ?? res())
      } catch {}
      try {
        db.close()
      } catch {}
    }
  }, 30000)

  it('explicit numeric LAN IP resolves to plain HTTP without cert/key (explicit transport, no encryption claim)', () => {
    expect(resolveRelayTls('192.168.1.10').scheme).toBe('http')
    expect(resolveRelayTls('192.168.1.10', undefined, undefined).scheme).toBe('http')
    expect(parseRelayArgs(['--host', '192.168.1.10'], {}).host).toBe('192.168.1.10')
  })

  it('loopback plain HTTP regression: health works without cert/key', async () => {
    const db = new Database(':memory:')
    let server: ReturnType<typeof createRelayServer> | undefined
    try {
      server = createRelayServer(db, { token: TOKEN })
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        server!.listen(0, '127.0.0.1', () => {
          const addr = server!.address()
          if (typeof addr === 'object' && addr) resolvePort(addr.port)
          else rejectPort(new Error('no bound port'))
        })
        server!.on('error', rejectPort)
      })
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { ok?: unknown }).ok).toBe(true)
    } finally {
      try {
        await new Promise<void>((res) => server?.close(() => res()) ?? res())
      } catch {}
      try {
        db.close()
      } catch {}
    }
  }, 30000)

  it.runIf(LAN_IP !== null)(
    'native HTTPS child on the discovered LAN host serves health, retains DB on SIGTERM',
    async () => {
      const lan = LAN_IP as string
      const root = mkdtempSync(join(tmpdir(), 'sync-relay-lan-'))
      const dbPath = join(root, 'lan-relay.db')
      let child: ChildProcess | null = null
      let cleanupFailure: Error | null = null
      try {
        const { certPath, keyPath } = generateServerCert(root, lan, 'lan')
        child = spawn(
          process.execPath,
          [
            TSX_ENTRY,
            SERVER_ENTRY,
            '--host',
            lan,
            '--port',
            '0',
            '--db',
            dbPath,
            '--token',
            TOKEN,
            '--cert',
            certPath,
            '--key',
            keyPath
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        let out = ''
        const port = await new Promise<number>((resolvePort, rejectPort) => {
          const timer = setTimeout(
            () => rejectPort(new Error(`readiness timeout: ${out.slice(-300)}`)),
            START_TIMEOUT_MS
          )
          timer.unref?.()
          const readyRe = new RegExp(`\\[sync-relay\\] listening on https://${lan.replace(/\./g, '\\.')}:([0-9]+)`)
          child!.stdout?.on('data', (c: Buffer) => {
            out += c.toString('utf8')
            const m = readyRe.exec(out)
            if (m) {
              clearTimeout(timer)
              resolvePort(Number(m[1]))
            }
          })
          child!.stderr?.on('data', (c: Buffer) => {
            out += c.toString('utf8')
          })
          child!.on('exit', (code, signal) => {
            clearTimeout(timer)
            rejectPort(new Error(`exited before readiness code=${code} signal=${signal}: ${out.slice(-300)}`))
          })
        })
        const health = await httpsHealth(`https://${lan}:${port}/health`, certPath)
        expect(health.status).toBe(200)
        // Normal SIGTERM stop retains the user-owned DB.
        child.kill('SIGTERM')
        await waitExit(child, STOP_TIMEOUT_MS)
        expect(child.exitCode).toBe(0)
        expect(existsSync(dbPath)).toBe(true)
        child = null
      } finally {
        let terminationProven = true
        if (child) {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM')
              try {
                await waitExit(child, STOP_TIMEOUT_MS)
              } catch {
                try {
                  child.kill('SIGKILL')
                } catch {
                  terminationProven = false
                }
                try {
                  await waitExit(child, STOP_TIMEOUT_MS)
                } catch {
                  terminationProven = false
                }
              }
              if (child.exitCode === null && child.signalCode === null) terminationProven = false
            }
          } catch {
            terminationProven = false
          }
        }
        // Never delete owned artifacts before terminal child exit is proven;
        // on unproven termination preserve the root and surface the failure
        // after the finally block (no control-flow throw inside finally).
        const allExited = child === null || child.exitCode !== null || child.signalCode !== null
        if (!terminationProven || !allExited) {
          cleanupFailure = new Error('LAN HTTPS child termination unproven; artifacts preserved')
        } else {
          rmSync(root, { recursive: true, force: true })
        }
      }
      if (cleanupFailure) throw cleanupFailure
    },
    90000
  )
})
