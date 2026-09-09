/**
 * User-entrypoint contract for the personal sync relay.
 *
 * Covers the one supported launch contract (`pnpm sync:relay` ->
 * `scripts/sync-relay/server.ts`): stable CLI args, SYNC_RELAY_TOKEN fallback,
 * loopback HTTP plus non-loopback HTTP/HTTPS host/TLS behavior (loopback
 * `127.0.0.1`/`localhost` serves plain HTTP; explicit numeric non-loopback
 * LAN IPs serve plain HTTP unless --cert/--key select native HTTPS; the
 * container-internal 0.0.0.0/:: bind requires --allow-unspecified-bind and
 * is never a user-facing advertised endpoint), --help, and graceful SIGTERM
 * shutdown that retains the DB. The runner never imports better-sqlite3; the
 * owned child owns the SQLite binding under the pinned Node/tsx runtime.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  formatRelayReadiness,
  isBridgeBindAttested,
  isLoopbackHost,
  isUnspecifiedBindHost,
  isWildcardHost,
  parseRelayArgs,
  RELAY_BRIDGE_ATTEST_ENV,
  RELAY_BRIDGE_ATTEST_VALUE,
  RELAY_HELP_TEXT,
  resolveRelayTls
} from '../server'

const SERVER_ENTRY = resolve(process.cwd(), 'scripts/sync-relay/server.ts')
const TSX_ENTRY = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const TOKEN = 'user-entrypoint-token-1'
const READINESS_RE = /\[sync-relay\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const START_TIMEOUT_MS = 15000
const HEALTH_TIMEOUT_MS = 10000
const REQUEST_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 8000

describe('relay user-entrypoint CLI contract', () => {
  it('package script sync:relay maps to the reference relay entrypoint', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['sync:relay']).toBe('tsx scripts/sync-relay/server.ts')
    expect(existsSync(SERVER_ENTRY)).toBe(true)
  })

  it('parses stable args with env token fallback and CLI precedence', () => {
    const cwdDb = resolve(process.cwd(), 'tmp-sync-relay.db')
    expect(parseRelayArgs([], {})).toMatchObject({ port: 3030, dbPath: cwdDb, host: '127.0.0.1', help: false })
    expect(parseRelayArgs([], {}).token).toBeUndefined()
    expect(parseRelayArgs([], { SYNC_RELAY_TOKEN: 'env-token' }).token).toBe('env-token')
    const over = parseRelayArgs(['--port', '4123', '--db', '/tmp/x.db', '--token', 'cli-token'], {
      SYNC_RELAY_TOKEN: 'env-token'
    })
    expect(over.port).toBe(4123)
    expect(over.dbPath).toBe(resolve('/tmp/x.db'))
    expect(over.token).toBe('cli-token')
    expect(over.host).toBe('127.0.0.1')
    expect(parseRelayArgs(['--host', 'localhost'], {}).host).toBe('127.0.0.1')
    expect(parseRelayArgs(['--help'], {}).help).toBe(true)
    expect(parseRelayArgs(['-h'], {}).help).toBe(true)
    expect(RELAY_HELP_TEXT).toContain('--port')
    expect(RELAY_HELP_TEXT).toContain('--db')
    expect(RELAY_HELP_TEXT).toContain('--token')
    expect(RELAY_HELP_TEXT).toContain('pnpm sync:relay')
  })

  it('rejects invalid port and guards hosts without touching the DB', () => {
    expect(() => parseRelayArgs(['--port', 'abc'], {})).toThrow(/invalid --port/)
    expect(() => parseRelayArgs(['--port', '-1'], {})).toThrow(/invalid --port/)
    expect(() => parseRelayArgs(['--port', '70000'], {})).toThrow(/invalid --port/)
    // Non-loopback hosts parse and serve plain HTTP by default; --cert/--key
    // select native HTTPS. Plain HTTP is unencrypted (client warns).
    expect(parseRelayArgs(['--host', '192.168.1.2'], {}).host).toBe('192.168.1.2')
    expect(resolveRelayTls('192.168.1.2').scheme).toBe('http')
    // Wildcard binds stay forbidden for direct host runs, even with cert/key.
    expect(() => resolveRelayTls('0.0.0.0')).toThrow(/wildcard.*forbidden/)
    expect(() => resolveRelayTls('::')).toThrow(/wildcard.*forbidden/)
    expect(() => parseRelayArgs(['--host', '0.0.0.0'], {})).toThrow(/wildcard/)
    expect(() => parseRelayArgs(['--host', '::'], {})).toThrow(/wildcard/)
    // The container-internal bridge bind is deployment-scoped: allowed only
    // with --allow-unspecified-bind plus Docker-bridge attestation (internal
    // entrypoint marker + container indicator), never a user-facing endpoint.
    expect(isUnspecifiedBindHost('0.0.0.0')).toBe(true)
    expect(isUnspecifiedBindHost('::')).toBe(true)
    expect(isUnspecifiedBindHost('192.168.1.2')).toBe(false)
    // Direct host runs: the flag alone is rejected even with an unspecified host.
    expect(() => parseRelayArgs(['--host', '0.0.0.0', '--allow-unspecified-bind'], {})).toThrow(
      /allow-unspecified-bind.*deployment-scoped/
    )
    expect(() => parseRelayArgs(['--allow-unspecified-bind'], {})).toThrow(/allow-unspecified-bind.*deployment-scoped/)
    expect(() => resolveRelayTls('0.0.0.0', undefined, undefined, { allowUnspecifiedBind: true })).toThrow(
      /allow-unspecified-bind.*deployment-scoped/
    )
    expect(() => resolveRelayTls('0.0.0.0', undefined, undefined, { allowUnspecifiedBind: false })).toThrow(
      /wildcard.*forbidden/
    )
    // Marker alone without a container indicator does not attest.
    expect(isBridgeBindAttested({ [RELAY_BRIDGE_ATTEST_ENV]: RELAY_BRIDGE_ATTEST_VALUE }, () => false)).toBe(false)
    expect(isBridgeBindAttested({}, () => true)).toBe(false)
    const attestedEnv = { [RELAY_BRIDGE_ATTEST_ENV]: RELAY_BRIDGE_ATTEST_VALUE } as NodeJS.ProcessEnv
    const containerExists = (p: string): boolean => p === '/.dockerenv'
    expect(isBridgeBindAttested(attestedEnv, containerExists)).toBe(true)
    expect(parseRelayArgs(['--host', '0.0.0.0', '--allow-unspecified-bind'], attestedEnv, containerExists).host).toBe(
      '0.0.0.0'
    )
    expect(parseRelayArgs(['--host', '::', '--allow-unspecified-bind'], attestedEnv, containerExists).host).toBe('::')
    expect(
      resolveRelayTls('0.0.0.0', undefined, undefined, {
        allowUnspecifiedBind: true,
        env: attestedEnv,
        bridgeExists: containerExists
      }).scheme
    ).toBe('http')
    // Marker with a non-container filesystem still fails.
    expect(() => parseRelayArgs(['--host', '0.0.0.0', '--allow-unspecified-bind'], attestedEnv, () => false)).toThrow(
      /allow-unspecified-bind.*deployment-scoped/
    )
    // Readiness contract: unspecified binds never emit URL-shaped wildcards.
    expect(formatRelayReadiness('0.0.0.0', 'http', 3030)).toBe(
      '[sync-relay] listening on http (internal bind) port 3030'
    )
    expect(formatRelayReadiness('::', 'http', 3030)).toBe('[sync-relay] listening on http (internal bind) port 3030')
    expect(formatRelayReadiness('0.0.0.0', 'https', 3030)).toBe(
      '[sync-relay] listening on https (internal bind) port 3030'
    )
    expect(formatRelayReadiness('0.0.0.0', 'http', 3030)).not.toContain('http://0.0.0.0')
    expect(formatRelayReadiness('::', 'http', 3030)).not.toContain('http://')
    expect(formatRelayReadiness('127.0.0.1', 'http', 4123)).toBe('[sync-relay] listening on http://127.0.0.1:4123')
    expect(formatRelayReadiness('192.168.1.2', 'http', 4123)).toBe('[sync-relay] listening on http://192.168.1.2:4123')
    expect(isWildcardHost('0.0.0.0')).toBe(true)
    expect(isWildcardHost('::')).toBe(true)
    expect(resolveRelayTls('127.0.0.1').scheme).toBe('http')
    expect(() => parseRelayArgs(['--port'], {})).toThrow(/missing value for --port/)
    expect(() => parseRelayArgs(['--db'], {})).toThrow(/missing value for --db/)
    expect(() => parseRelayArgs(['--token'], {})).toThrow(/missing value for --token/)
    expect(() => parseRelayArgs(['--host'], {})).toThrow(/missing value for --host/)
    expect(() => parseRelayArgs(['--unknown'], {})).toThrow(/unknown option/)
    expect(() => parseRelayArgs(['--port=3030'], {})).toThrow(/unknown option/)
    expect(() => parseRelayArgs(['extra-positional'], {})).toThrow(/unknown option/)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })

  it('--help exits 0 with usage on stdout', () => {
    const res = spawnSync(process.execPath, [TSX_ENTRY, SERVER_ENTRY, '--help'], {
      timeout: 30000,
      encoding: 'utf8'
    })
    expect(res.status).toBe(0)
    expect(String(res.stdout)).toContain('pnpm sync:relay')
    expect(String(res.stdout)).toContain('--port')
  }, 30000)

  it('direct --allow-unspecified-bind without bridge attestation fails before DB creation', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-cli-'))
    const dbPath = join(root, 'should-not-exist.db')
    try {
      // Direct host run: Docker-bridge flag without the internal entrypoint
      // attestation (marker + container indicator) must fail. No marker is
      // provided here, so startup rejects before the DB is opened.
      const res = spawnSync(
        process.execPath,
        [
          TSX_ENTRY,
          SERVER_ENTRY,
          '--host',
          '0.0.0.0',
          '--allow-unspecified-bind',
          '--port',
          '0',
          '--db',
          dbPath,
          '--token',
          TOKEN
        ],
        { timeout: 30000, encoding: 'utf8', env: { ...process.env, [RELAY_BRIDGE_ATTEST_ENV]: '' } }
      )
      expect(res.status).toBe(2)
      expect(`${String(res.stderr)}${String(res.stdout)}`).toMatch(/allow-unspecified-bind.*deployment-scoped/)
      expect(existsSync(dbPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)

  it('invalid --port exits 2 without creating the DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-cli-'))
    const dbPath = join(root, 'should-not-exist.db')
    try {
      const res = spawnSync(process.execPath, [TSX_ENTRY, SERVER_ENTRY, '--port', 'abc', '--db', dbPath], {
        timeout: 30000,
        encoding: 'utf8'
      })
      expect(res.status).toBe(2)
      expect(existsSync(dbPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)

  it('missing token exits 2 without creating the DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-cli-'))
    const dbPath = join(root, 'should-not-exist.db')
    try {
      const res = spawnSync(process.execPath, [TSX_ENTRY, SERVER_ENTRY, '--port', '0', '--db', dbPath], {
        timeout: 30000,
        encoding: 'utf8',
        env: { ...process.env, SYNC_RELAY_TOKEN: '' }
      })
      expect(res.status).toBe(2)
      expect(`${String(res.stderr)}${String(res.stdout)}`).toMatch(/missing --token/)
      expect(existsSync(dbPath)).toBe(false)
      expect(existsSync(`${dbPath}-wal`)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)

  it('unknown option and missing value exit 2 without creating the DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-cli-'))
    const dbPath = join(root, 'should-not-exist.db')
    try {
      const unknown = spawnSync(
        process.execPath,
        [TSX_ENTRY, SERVER_ENTRY, '--nope', '--db', dbPath, '--token', TOKEN],
        { timeout: 30000, encoding: 'utf8' }
      )
      expect(unknown.status).toBe(2)
      expect(`${String(unknown.stderr)}${String(unknown.stdout)}`).toMatch(/unknown option/)
      const missing = spawnSync(process.execPath, [TSX_ENTRY, SERVER_ENTRY, '--port'], {
        timeout: 30000,
        encoding: 'utf8'
      })
      expect(missing.status).toBe(2)
      expect(`${String(missing.stderr)}${String(missing.stdout)}`).toMatch(/missing value/)
      expect(existsSync(dbPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
})

describe('relay user-entrypoint graceful shutdown', () => {
  it('SIGTERM closes cleanly once, retains the DB, and restart retains state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-relay-user-'))
    const dbPath = join(root, 'relay.db')
    // Registered + paired channel identity for the data plane (SYNC-CC-*).
    let paired: { code: string; secret: string } | null = null
    const provisionPair = async (baseUrl: string): Promise<{ code: string; secret: string }> => {
      if (paired) return paired
      const authed = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
      const reg = async (deviceId: string): Promise<{ code: string; secret: string }> => {
        const res = await fetch(`${baseUrl}/sync/register`, {
          method: 'POST',
          headers: authed,
          body: JSON.stringify({ deviceId }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (res.status !== 200) throw new Error(`provision register failed: ${res.status}`)
        const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
        return { code: body.deviceCode, secret: body.deviceSecret }
      }
      const a = await reg('user-device-1')
      const b = await reg('user-device-2')
      const req = await fetch(`${baseUrl}/sync/pair/request`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': b.code, 'x-sync-device-secret': b.secret },
        body: JSON.stringify({ targetCode: a.code }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (req.status !== 200) throw new Error(`provision request failed: ${req.status}`)
      const reqBody = (await req.json()) as { requestId: string }
      const accept = await fetch(`${baseUrl}/sync/pair/accept`, {
        method: 'POST',
        headers: { ...authed, 'x-sync-device-code': a.code, 'x-sync-device-secret': a.secret },
        body: JSON.stringify({ requestId: reqBody.requestId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (accept.status !== 200) throw new Error(`provision accept failed: ${accept.status}`)
      paired = a
      return a
    }
    const push = async (baseUrl: string, n: number): Promise<{ status: number; cursor: number }> => {
      const dev = await provisionPair(baseUrl)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
        'x-sync-device-code': dev.code,
        'x-sync-device-secret': dev.secret
      }
      const res = await fetch(`${baseUrl}/sync/push`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deviceId: 'user-device-1',
          operations: [
            {
              id: `user-op-${n}`,
              entityType: 'topic',
              op: 'upsert',
              entityId: `user-topic-${n}`,
              timestamp: 1700000000000 + n,
              deviceId: 'user-device-1',
              payload: { id: `user-topic-${n}`, name: `User Topic ${n}` }
            }
          ]
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const body = (await res.json()) as { cursor?: number }
      return { status: res.status, cursor: body.cursor ?? -1 }
    }
    const pull = async (
      baseUrl: string,
      cursor: number
    ): Promise<{ status: number; cursor: number; ids: string[] }> => {
      const dev = await provisionPair(baseUrl)
      const headers: Record<string, string> = {
        Authorization: `Bearer ${TOKEN}`,
        'x-sync-device-code': dev.code,
        'x-sync-device-secret': dev.secret
      }
      const res = await fetch(`${baseUrl}/sync/pull?cursor=${cursor}&deviceId=user-device-1`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const body = (await res.json()) as { operations?: Array<{ id: string }>; cursor?: number }
      return { status: res.status, cursor: body.cursor ?? -1, ids: (body.operations ?? []).map((o) => o.id) }
    }
    const waitExit = (child: ChildProcess, ms: number): Promise<void> =>
      new Promise((res, rej) => {
        if (child.exitCode !== null || child.signalCode !== null) return res()
        const t = setTimeout(() => rej(new Error('relay did not exit after SIGTERM')), ms)
        t.unref?.()
        child.once('exit', () => {
          clearTimeout(t)
          res()
        })
      })
    const failedStarts: ChildProcess[] = []
    const start = (port: string): Promise<{ child: ChildProcess; baseUrl: string; logs: () => string }> =>
      new Promise((resolveStart, rejectStart) => {
        const child = spawn(
          process.execPath,
          [TSX_ENTRY, SERVER_ENTRY, '--port', port, '--db', dbPath, '--token', TOKEN],
          {
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        let out = ''
        let settled = false
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // Retain ownership of the failed child so finally can prove
          // terminal exit before deleting artifacts. Bounded owned-PID-only
          // SIGTERM then SIGKILL escalation; an unproven child stays retained
          // and the rejection aggregates the cleanup failure.
          failedStarts.push(child)
          void (async () => {
            try {
              if (child.exitCode === null && child.signalCode === null) {
                try {
                  child.kill('SIGTERM')
                } catch {}
                try {
                  await waitExit(child, STOP_TIMEOUT_MS)
                } catch {
                  try {
                    child.kill('SIGKILL')
                  } catch {}
                  await waitExit(child, STOP_TIMEOUT_MS)
                }
              }
            } catch {}
            const proven = child.exitCode !== null || child.signalCode !== null
            if (proven) {
              const idx = failedStarts.indexOf(child)
              if (idx >= 0) failedStarts.splice(idx, 1)
              rejectStart(err)
            } else {
              rejectStart(
                new AggregateError(
                  [
                    err,
                    new Error(
                      `relay startup cleanup could not prove child termination (pid=${child.pid}); artifacts preserved`
                    )
                  ],
                  'relay startup failed; cleanup also failed'
                )
              )
            }
          })()
        }
        const timer = setTimeout(() => {
          fail(new Error(`relay readiness timeout: ${out.slice(-500)}`))
        }, START_TIMEOUT_MS)
        timer.unref?.()
        child.stdout?.on('data', (c: Buffer) => {
          out += c.toString('utf8')
          const m = READINESS_RE.exec(out)
          if (m && !settled) {
            settled = true
            clearTimeout(timer)
            resolveStart({ child, baseUrl: `http://127.0.0.1:${m[1]}`, logs: () => out })
          }
        })
        child.stderr?.on('data', (c: Buffer) => {
          out += c.toString('utf8')
        })
        child.on('exit', (code, signal) => {
          fail(new Error(`relay exited before readiness code=${code} signal=${signal}: ${out.slice(-500)}`))
        })
      })
    const waitHealth = async (baseUrl: string): Promise<void> => {
      const deadline = Date.now() + HEALTH_TIMEOUT_MS
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
          if (res.ok) return
        } catch {}
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('health timeout')
    }
    let first: { child: ChildProcess; baseUrl: string; logs: () => string } | undefined
    let second: { child: ChildProcess; baseUrl: string; logs: () => string } | undefined
    let cleanupFailure: Error | null = null
    try {
      first = await start('0')
      await waitHealth(first.baseUrl)
      const p1 = await push(first.baseUrl, 1)
      expect(p1.status).toBe(200)
      expect(p1.cursor).toBe(1)
      const port = new URL(first.baseUrl).port
      // Hold one active SSE stream so shutdown must close active
      // connections before server.close can complete.
      const sseAbort = new AbortController()
      const sseOpen = fetch(`${first.baseUrl}/sync/subscribe?cursor=0`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: sseAbort.signal
      })
        .then(async (r) => {
          if (r.status !== 200) throw new Error(`sse status ${r.status}`)
          const reader = r.body?.getReader()
          await reader?.read()
        })
        .catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
      // Graceful SIGTERM exactly once: second SIGTERM must not change the outcome.
      first.child.kill('SIGTERM')
      first.child.kill('SIGTERM')
      await waitExit(first.child, STOP_TIMEOUT_MS)
      sseAbort.abort()
      await sseOpen.catch(() => {})
      const logs = first.logs()
      expect(logs.match(/received SIGTERM, shutting down/g) ?? []).toHaveLength(1)
      expect(logs.match(/\[sync-relay\] shutdown complete/g) ?? []).toHaveLength(1)
      expect(first.child.exitCode).toBe(0)
      expect(first.child.signalCode).toBeNull()
      // Normal stop never deletes user data.
      expect(existsSync(dbPath)).toBe(true)
      await expect(fetch(first.baseUrl, { signal: AbortSignal.timeout(2000) })).rejects.toThrow()
      // Restart on the same DB/token retains relay state with sequence continuity.
      second = await start(port)
      await waitHealth(second.baseUrl)
      expect(second.baseUrl).toBe(first.baseUrl)
      const retained = await pull(second.baseUrl, 0)
      expect(retained.status).toBe(200)
      expect(retained.cursor).toBe(1)
      expect(retained.ids).toEqual(['user-op-1'])
      const p2 = await push(second.baseUrl, 2)
      expect(p2.status).toBe(200)
      expect(p2.cursor).toBe(2)
    } finally {
      let terminationProven = true
      const allHandles: ChildProcess[] = []
      for (const h of [second, first]) if (h) allHandles.push(h.child)
      for (const c of failedStarts) if (!allHandles.includes(c)) allHandles.push(c)
      for (const child of allHandles) {
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
      const allExited = allHandles.every((child) => child.exitCode !== null || child.signalCode !== null)
      if (!terminationProven || !allExited) {
        cleanupFailure = new Error('relay cleanup could not prove child termination; artifacts preserved')
      } else {
        rmSync(root, { recursive: true, force: true })
      }
    }
    if (cleanupFailure) throw cleanupFailure
  }, 90000)
})
