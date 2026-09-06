/**
 * User-entrypoint relay launcher for the persistent personal-relay E2E.
 *
 * Spawns the exact first-party user entrypoint file
 * (`scripts/sync-relay/server.ts`, wired as `pnpm sync:relay`) with the same
 * stable CLI args (`--port/--db/--token`, plus `--host/--cert/--key` for the
 * LAN HTTPS opt-in) a user passes. The only deliberate
 * difference from a shell `pnpm sync:relay` is the runtime launcher: the E2E
 * lane runs the entrypoint under the Electron binary as Node
 * (`ELECTRON_RUN_AS_NODE=1`) so the better-sqlite3 binding loads as ABI 145,
 * while a user shell runs the same file via `tsx` under Node ABI 137. The
 * script file, CLI contract, readiness line, and relay semantics are
 * identical — verified below by asserting the package script mapping before
 * spawn and the stable readiness line after spawn: loopback HTTP advertises
 * `http://127.0.0.1:PORT`, while non-loopback LAN HTTPS advertises
 * `https://<host>:PORT` (IPv6 bracketed via the shared URL formatter).
 *
 * Ownership: the DB lives under the caller-owned temp root. stop() retains
 * the DB (normal stop never deletes user data); close() stops the exact owned
 * child then removes only disposable artifacts beneath the owned root.
 * Every live/failed handle registers in run-ownership so root teardown blocks
 * while ownership is unresolved. Must NOT be imported by production app code.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { get as httpsGet } from 'node:https'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { registerOwnedRelayHandle, unregisterOwnedRelayHandle, validateOwnedRoot } from './run-ownership'
import { formatRelayHostForUrl, normalizeRelayBindHost } from '../../../scripts/sync-relay/relayHost'

export interface UserEntrypointRelayOptions {
  ownedTmpRoot: string
  token: string
  dbFileName?: string
  readyTimeoutMs?: number
  stopTimeoutMs?: number
  /**
   * LAN HTTPS opt-in (single supported secure LAN topology): non-loopback
   * bind host with the relay-native HTTPS cert/key pair. When set, the child
   * spawns with `--host/--cert/--key`, readiness advertises
   * `https://<host>:<port>`, and health is verified with explicit `ca` trust
   * (never verification bypass). Omitted: loopback plain HTTP (unchanged).
   */
  host?: string
  certPath?: string
  keyPath?: string
  /** Explicit CA file for health verification; defaults to certPath. */
  caPath?: string
}

export interface UserEntrypointRelayHandle {
  readonly endpoint: string
  readonly port: number
  readonly token: string
  readonly dbPath: string
  pid(): number | null
  isRunning(): boolean
  stop(): Promise<void>
  restart(): Promise<void>
  close(): Promise<void>
}

export class UserRelayStartupError extends Error {
  readonly relay: UserEntrypointRelayHandle
  readonly cleanupError: string | null
  constructor(message: string, relay: UserEntrypointRelayHandle, cleanupError: string | null = null) {
    super(message)
    this.name = 'UserRelayStartupError'
    this.relay = relay
    this.cleanupError = cleanupError
  }
}

export function getUserRelayHandle(error: unknown): UserEntrypointRelayHandle | null {
  if (error instanceof UserRelayStartupError) return error.relay
  const relay = (error as { relay?: unknown } | null)?.relay
  if (
    relay &&
    typeof relay === 'object' &&
    typeof (relay as UserEntrypointRelayHandle).isRunning === 'function' &&
    typeof (relay as UserEntrypointRelayHandle).close === 'function'
  ) {
    return relay as UserEntrypointRelayHandle
  }
  return null
}

const READY_DEFAULT_MS = 30000
const STOP_DEFAULT_MS = 10000
const KILL_GRACE_MS = 5000
const HEALTH_POLL_MS = 250

/**
 * Fail-closed launcher gate mirroring the relay TLS contract: an explicitly
 * supplied non-loopback bind host requires the native HTTPS cert/key pair.
 * Default loopback (no explicit host) and explicit loopback
 * (`127.0.0.1`/`localhost`, including bracketed `[127.0.0.1]`) remain plain
 * HTTP without cert/key. Throws before any child is spawned or DB path is
 * touched, so invalid launcher configuration never creates a child/DB.
 */
export function assertUserRelayHostTlsConfig(normalizedHost: string, hasTls: boolean, hostWasExplicit: boolean): void {
  if (!hostWasExplicit) return
  const loopback = normalizedHost === '127.0.0.1' || normalizedHost === 'localhost'
  if (!loopback && !hasTls) {
    throw new Error(
      'sync-relay-user-entrypoint: non-loopback host requires certPath and keyPath (native HTTPS required; plaintext LAN binding rejected)'
    )
  }
}

/**
 * Canonical advertised host for readiness/endpoint/health URLs.
 *
 * Mirrors the production relay canonicalization (`scripts/sync-relay/server.ts`
 * normalizes explicit `localhost` to `127.0.0.1` before bind and always emits
 * loopback HTTP readiness as `http://127.0.0.1:<port>`): explicit/default
 * loopback (`127.0.0.1`/`localhost`) advertises as `127.0.0.1`. All other
 * hosts (explicit LAN IP, IPv6 literals) pass through unchanged; the raw
 * normalized host remains appropriate only for `server.listen` (`--host`).
 */
export function resolveUserRelayUrlHost(normalizedHost: string): string {
  const trimmed = normalizedHost.trim()
  if (trimmed === 'localhost' || trimmed === '127.0.0.1') return '127.0.0.1'
  return normalizedHost
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveRepoRoot(): string {
  const candidate = process.cwd()
  const stat = fs.lstatSync(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !fs.existsSync(path.join(candidate, 'package.json'))) {
    throw new Error('sync-relay-user-entrypoint: cannot resolve repository root')
  }
  return fs.realpathSync(candidate)
}

/**
 * Prove the user entrypoint is the tested file: package.json `sync:relay`
 * must reference `scripts/sync-relay/server.ts`. A wrapper that silently
 * changes behavior would fail this gate (wrong file) or the readiness/HTTP
 * behavior assertions in the spec.
 */
export function assertPackageEntrypoint(repoRoot: string): string {
  const pkgPath = path.join(repoRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
  const script = pkg.scripts?.['sync:relay']
  if (script !== 'tsx scripts/sync-relay/server.ts') {
    throw new Error(
      'sync-relay-user-entrypoint: package script sync:relay must equal "tsx scripts/sync-relay/server.ts"'
    )
  }
  const entry = path.join(repoRoot, 'scripts', 'sync-relay', 'server.ts')
  if (!fs.existsSync(entry)) throw new Error('sync-relay-user-entrypoint: relay entrypoint file missing')
  return entry
}

function resolveElectronBinary(repoRoot: string): string {
  const runnerRequire: NodeRequire =
    typeof require !== 'undefined' ? require : createRequire(path.join(repoRoot, 'package.json'))
  const electronPath = runnerRequire('electron') as string
  if (!electronPath || typeof electronPath !== 'string') {
    throw new Error('sync-relay-user-entrypoint: electron binary path missing')
  }
  return electronPath
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true
    await sleep(100)
  }
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForHealth(endpoint: string, timeoutMs: number, caPath?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      if (caPath && endpoint.startsWith('https://')) {
        // Explicit CA trust for native HTTPS relays (no bypass).
        const res = await new Promise<{ status: number; ok: boolean }>((resolvePromise, rejectPromise) => {
          const req = httpsGet(`${endpoint}/health`, { ca: fs.readFileSync(caPath), timeout: 5000 }, (incoming) => {
            let data = ''
            incoming.on('data', (c: Buffer) => {
              data += c.toString('utf8')
            })
            incoming.on('end', () => {
              try {
                resolvePromise({
                  status: incoming.statusCode ?? 0,
                  ok: (JSON.parse(data) as { ok?: unknown }).ok === true
                })
              } catch (e) {
                rejectPromise(e)
              }
            })
          })
          req.on('timeout', () => req.destroy(new Error('health timeout')))
          req.on('error', rejectPromise)
        })
        if (res.status === 200 && res.ok) return
        last = `status ${res.status}`
      } else {
        const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) })
        if (res.status === 200) {
          const body = (await res.json()) as { ok?: unknown }
          if (body?.ok === true) return
          last = 'health body missing {ok:true}'
        } else {
          last = `status ${res.status}`
        }
      }
    } catch (e) {
      last = String((e as Error).message).slice(0, 120)
    }
    await sleep(Math.min(HEALTH_POLL_MS, Math.max(1, deadline - Date.now())))
  }
  throw new Error(`sync-relay-user-entrypoint: health readiness timeout (${last})`)
}

export async function startUserEntrypointRelay(
  options: UserEntrypointRelayOptions
): Promise<UserEntrypointRelayHandle> {
  if (!options || typeof options !== 'object') throw new Error('startUserEntrypointRelay requires options')
  const ownedTmpRoot = validateOwnedRoot(options.ownedTmpRoot)
  const token = options.token
  if (!token || typeof token !== 'string') throw new Error('startUserEntrypointRelay requires a non-empty token')
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_DEFAULT_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_DEFAULT_MS
  const repoRoot = resolveRepoRoot()
  const serverTs = assertPackageEntrypoint(repoRoot)
  const electronBinary = resolveElectronBinary(repoRoot)
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (!fs.existsSync(tsxCli)) throw new Error('sync-relay-user-entrypoint: tsx CLI missing')
  const suffix = uniqueSuffix()
  const dbFileName = options.dbFileName ?? `user-relay-${suffix}.db`
  if (dbFileName.includes('/') || dbFileName.includes('\\') || path.isAbsolute(dbFileName)) {
    throw new Error('sync-relay-user-entrypoint: dbFileName must be a bare file name')
  }
  const dbPath = path.join(ownedTmpRoot, dbFileName)
  if (path.relative(ownedTmpRoot, path.resolve(dbPath)).startsWith('..')) {
    throw new Error('sync-relay-user-entrypoint: DB escapes the owned root')
  }
  // LAN HTTPS opt-in validation: host/cert/key travel together (fail-closed).
  // Loopback HTTP (default/explicit 127.0.0.1 or explicit localhost, no
  // cert/key) serves plain HTTP with `http://127.0.0.1:<port>` readiness
  // (production normalizes localhost to 127.0.0.1 before bind); non-loopback
  // LAN hosts require --cert/--key, serve native HTTPS only, and advertise
  // `https://<host>:<port>` readiness (IPv6 bracketed). The raw normalized
  // bind host is passed to --host for server.listen except explicit localhost
  // loopback, which binds the canonical 127.0.0.1; the bracketed URL form
  // is used only for readiness matching, endpoint advertisement, and health
  // URLs. IPv4/loopback formatting is unchanged.
  const lanHostRaw = options.host ?? '127.0.0.1'
  let lanHost: string
  try {
    lanHost = normalizeRelayBindHost(lanHostRaw.trim())
  } catch (e) {
    throw new Error(`sync-relay-user-entrypoint: ${(e as Error).message}`)
  }
  const lanCert = options.certPath
  const lanKey = options.keyPath
  const lanCa = options.caPath ?? lanCert
  if ((lanCert !== undefined || lanKey !== undefined) && (!lanCert || !lanKey)) {
    throw new Error('sync-relay-user-entrypoint: certPath and keyPath are required together')
  }
  const useTls = !!lanCert && !!lanKey
  assertUserRelayHostTlsConfig(lanHost, useTls, options.host !== undefined)
  const scheme = useTls ? 'https' : 'http'
  // Canonicalize explicit/default localhost loopback to 127.0.0.1 for
  // readiness/endpoint/health, matching production readiness
  // (`http://127.0.0.1:<port>` for loopback HTTP, `https://127.0.0.1:<port>`
  // for loopback HTTPS opt-in). Non-loopback hosts keep the raw normalized
  // form for --host (server.listen); IPv6 URL bracketing applies only to the
  // advertised URL form.
  const advertisedHostRaw = resolveUserRelayUrlHost(lanHost)
  const urlHost = formatRelayHostForUrl(advertisedHostRaw)
  const escapedHost = urlHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const readyRe = new RegExp(`\\[sync-relay\\] listening on ${scheme}://${escapedHost}:(\\d+)`)

  let child: ChildProcess | null = null
  let boundPort: number | null = null
  let endpoint = 'http://127.0.0.1:0'
  const state = { closed: false }
  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: ownedTmpRoot,
    TMP: ownedTmpRoot,
    TEMP: ownedTmpRoot,
    NODE_PATH: path.join(repoRoot, 'node_modules')
  }

  async function reapAfterFailure(proc: ChildProcess): Promise<string | null> {
    const pid = proc.pid ?? null
    try {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        if (child === proc) child = null
        return null
      }
      try {
        proc.kill('SIGTERM')
      } catch {
        return `SIGTERM failed for owned relay PID ${pid}`
      }
      const exited = await waitForExit(proc, KILL_GRACE_MS)
      if (!exited) {
        try {
          proc.kill('SIGKILL')
        } catch {
          return `SIGKILL failed for owned relay PID ${pid}`
        }
        const killed = await waitForExit(proc, KILL_GRACE_MS)
        if (!killed) return `owned relay PID ${pid} survived SIGKILL after failed start`
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        if (child === proc) child = null
        return null
      }
      return `owned relay PID ${pid} survived SIGKILL after failed start`
    } catch (e) {
      return String((e as Error).message).slice(0, 200)
    }
  }

  async function startChild(requestedPort: number, budgetMs: number): Promise<{ endpoint: string; port: number }> {
    const tlsArgs = useTls ? ['--host', advertisedHostRaw, '--cert', lanCert as string, '--key', lanKey as string] : []
    const proc = spawn(
      electronBinary,
      [tsxCli, serverTs, '--port', String(requestedPort), '--db', dbPath, '--token', token, ...tlsArgs],
      {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child = proc
    let out = ''
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const timer = setTimeout(() => rejectPort(new Error('relay stdout readiness timeout')), budgetMs)
      const onData = (chunk: Buffer): void => {
        out += chunk.toString('utf8')
        if (out.length > 65536) out = out.slice(-65536)
        const m = readyRe.exec(out)
        if (m) {
          clearTimeout(timer)
          cleanup()
          resolvePort(Number(m[1]))
        }
      }
      const onErr = (chunk: Buffer): void => {
        out += chunk.toString('utf8')
        if (out.length > 65536) out = out.slice(-65536)
      }
      const onExit = (): void => {
        clearTimeout(timer)
        cleanup()
        rejectPort(new Error(`relay child exited before readiness: ${out.slice(-500)}`))
      }
      const cleanup = (): void => {
        proc.stdout?.removeListener('data', onData)
        proc.stderr?.removeListener('data', onErr)
        proc.removeListener('exit', onExit)
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onErr)
      proc.on('exit', onExit)
    }).catch(async (e) => {
      const cleanupErr = await reapAfterFailure(proc)
      const detail = String((e as Error).message).slice(0, 300)
      throw { detail, cleanupErr, phase: 'startup' as const }
    })
    const nextEndpoint = `${scheme}://${urlHost}:${port}`
    const remaining = budgetMs - 1000
    try {
      await waitForHealth(nextEndpoint, Math.max(1000, remaining), useTls ? lanCa : undefined)
    } catch (e) {
      const cleanupErr = await reapAfterFailure(proc)
      const detail = String((e as Error).message).slice(0, 300)
      throw { detail, cleanupErr, phase: 'readiness' as const }
    }
    return { endpoint: nextEndpoint, port }
  }

  function asStartFailureDetail(e: unknown): { detail: string; cleanupErr: string | null } | null {
    if (e && typeof e === 'object' && 'detail' in (e as Record<string, unknown>)) {
      const rec = e as { detail?: unknown; cleanupErr?: unknown }
      return {
        detail: String(rec.detail ?? 'relay startup failed').slice(0, 300),
        cleanupErr:
          typeof rec.cleanupErr === 'string' && rec.cleanupErr.length > 0
            ? rec.cleanupErr.slice(0, 200)
            : rec.cleanupErr === null || rec.cleanupErr === undefined
              ? null
              : String(rec.cleanupErr).slice(0, 200)
      }
    }
    return null
  }

  function startupErrorMessage(detail: string, cleanupErr: string | null, live: boolean): string {
    const base = live
      ? `sync-relay-user-entrypoint: startup failed with owned child still live; handle retained for retry; ${detail}`
      : cleanupErr
        ? `sync-relay-user-entrypoint: startup failed and owned child could not be reaped (${cleanupErr}); ${detail}`
        : `sync-relay-user-entrypoint: startup failed; owned child reaped; ${detail}`
    return cleanupErr && live ? `${base} (cleanup: ${cleanupErr})` : base
  }

  async function stopChild(): Promise<void> {
    const proc = child
    if (!proc) return
    if (proc.exitCode !== null || proc.signalCode !== null) {
      child = null
      return
    }
    try {
      proc.kill('SIGTERM')
    } catch {
      throw new Error('sync-relay-user-entrypoint: SIGTERM failed for owned relay')
    }
    const exited = await waitForExit(proc, stopTimeoutMs)
    if (!exited) {
      try {
        proc.kill('SIGKILL')
      } catch {
        throw new Error('sync-relay-user-entrypoint: SIGKILL failed for owned relay')
      }
      const killed = await waitForExit(proc, KILL_GRACE_MS)
      if (!killed) throw new Error('sync-relay-user-entrypoint: owned relay survived SIGKILL')
    }
    child = null
  }

  function buildHandle(): UserEntrypointRelayHandle {
    const handle: UserEntrypointRelayHandle = {
      get endpoint() {
        return endpoint
      },
      get port() {
        return boundPort ?? 0
      },
      token,
      dbPath,
      pid: () => child?.pid ?? null,
      isRunning: () => child !== null && child.exitCode === null && child.signalCode === null,
      stop: async () => {
        if (state.closed) throw new Error('sync-relay-user-entrypoint: handle is closed')
        await stopChild()
      },
      restart: async () => {
        if (state.closed) throw new Error('sync-relay-user-entrypoint: handle is closed')
        if (boundPort === null || boundPort <= 0) throw new Error('sync-relay-user-entrypoint: no bound port')
        const expected = boundPort
        await stopChild()
        let next: { endpoint: string; port: number }
        try {
          next = await startChild(expected, readyTimeoutMs)
        } catch (e) {
          const parsed = asStartFailureDetail(e)
          if (parsed) {
            let live = true
            try {
              live = handle.isRunning()
            } catch {
              live = true
            }
            throw new UserRelayStartupError(
              startupErrorMessage(parsed.detail, parsed.cleanupErr, live).slice(0, 500),
              handle,
              parsed.cleanupErr
            )
          }
          throw new UserRelayStartupError(String((e as Error).message).slice(0, 300), handle)
        }
        if (next.port !== expected) {
          throw new Error(`sync-relay-user-entrypoint: restarted relay changed port (${expected} -> ${next.port})`)
        }
        boundPort = next.port
        endpoint = next.endpoint
      },
      close: async () => {
        if (state.closed) return
        try {
          await stopChild()
        } catch (e) {
          throw new Error(
            `sync-relay-user-entrypoint: close could not prove child termination; artifacts preserved (${String((e as Error).message).slice(0, 200)})`
          )
        }
        if (child !== null) throw new Error('sync-relay-user-entrypoint: close could not prove child termination')
        for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
          try {
            fs.rmSync(target, { force: true })
          } catch (e) {
            throw new Error(
              `sync-relay-user-entrypoint: cleanup failed (${String((e as Error).message).slice(0, 120)})`
            )
          }
        }
        state.closed = true
        unregisterOwnedRelayHandle(handle)
      }
    }
    return handle
  }

  let first: { endpoint: string; port: number }
  try {
    first = await startChild(0, readyTimeoutMs)
  } catch (e) {
    const failed = buildHandle()
    registerOwnedRelayHandle(failed)
    const parsed = asStartFailureDetail(e)
    if (parsed) {
      let live = true
      try {
        live = failed.isRunning()
      } catch {
        live = true
      }
      throw new UserRelayStartupError(
        startupErrorMessage(parsed.detail, parsed.cleanupErr, live).slice(0, 500),
        failed,
        parsed.cleanupErr
      )
    }
    throw new UserRelayStartupError(String((e as Error).message).slice(0, 300), failed)
  }
  boundPort = first.port
  endpoint = first.endpoint
  const handle = buildHandle()
  registerOwnedRelayHandle(handle)
  return handle
}
