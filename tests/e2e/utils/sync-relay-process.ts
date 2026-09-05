/**
 * File-backed reference relay child for the relay-restart E2E increment.
 *
 * Test-only harness around the reference relay contract
 * (scripts/sync-relay/server.ts). The production server TypeScript is bundled
 * verbatim with the repo esbuild binary into a temporary CJS launcher under
 * the owned temp root, then executed as a controlled owned child under the
 * Electron lane (`ELECTRON_RUN_AS_NODE=1` on the Electron binary) so the
 * native better-sqlite3 binding loads as ABI 145 in the child.
 *
 * Lane discipline:
 *   - The Playwright/Vitest runner process NEVER imports better-sqlite3 here
 *     (only path strings and the Electron binary path string).
 *   - `ELECTRON_RUN_AS_NODE=1` is set ONLY on the spawned child env, never on
 *     the runner process env.
 *   - `TMPDIR/TMP/TEMP` point at the owned temp root for the child.
 *   - better-sqlite3 resolves in the child via NODE_PATH pointing at the repo
 *     `node_modules` (the bundle keeps it external).
 *   - No `process.execPath` use: the child is always the Electron binary from
 *     the `electron` dependency. No broad process killing: only the exact
 *     owned child PID is ever signaled, with bounded SIGTERM then SIGKILL
 *     escalation.
 *
 * Durability scope: file-backed reference relay only for this increment; no
 * production deployment durability claim and no app abnormal-exit coverage.
 * Main-process SQLite remains the chat authority; the relay stores/forwards
 * operations only. SSE stays hint-only.
 *
 * Ownership scope: every spawned relay child is externally reachable from the
 * moment of spawn. Startup/readiness failures throw a
 * FileBackedRelayStartupError carrying the owned handle, and every live
 * handle is registered in the module-global live set so root teardown can
 * block deletion while a child lives (fail-closed). Restart reuses the
 * already-tracked handle (no second registration); a failed restart carries
 * that same handle so one close() resolves all owned state.
 *
 * Must NOT be imported by production app code.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import {
  assertNoLiveOwnedRelayChild,
  assertNoUnresolvedOwnedRelayCleanup,
  hasLiveOwnedRelayChild,
  hasUnresolvedOwnedRelayCleanup,
  registerOwnedRelayHandle,
  unregisterOwnedRelayHandle,
  validateOwnedRoot
} from './run-ownership'

export interface FileBackedRelayOptions {
  /** Ownership-safe temp root; bundle + DB live beneath it. */
  ownedTmpRoot: string
  /** Bearer token required for push/pull (non-empty). */
  token: string
  /** DB file name under the owned root (default unique). */
  dbFileName?: string
  /** Bundle file name under the owned root (default unique). */
  bundleFileName?: string
  /** Readiness budget per start in ms (default 30000). */
  readyTimeoutMs?: number
  /** SIGTERM grace before SIGKILL escalation in ms (default 10000). */
  stopTimeoutMs?: number
}

export interface FileBackedRelayHandle {
  /** Stable HTTP endpoint, e.g. http://127.0.0.1:PORT. */
  readonly endpoint: string
  /** Bound port (ephemeral first start, then pinned for restart). */
  readonly port: number
  readonly token: string
  readonly dbPath: string
  /** Owned child PID, or null when stopped. */
  pid(): number | null
  isRunning(): boolean
  /** Bounded SIGTERM then SIGKILL stop; retains the DB files. */
  stop(): Promise<void>
  /** Stop (if running) then start the same bundle against the same DB/token/port. */
  restart(): Promise<void>
  /** Stop then remove bundle + DB files (fail-closed). */
  close(): Promise<void>
}

/** Startup/readiness failure that retains the owned relay handle for cleanup. */
export class FileBackedRelayStartupError extends Error {
  readonly relay: FileBackedRelayHandle
  readonly relayPid: number | null
  readonly cleanupError: string | null
  constructor(message: string, relay: FileBackedRelayHandle, cleanupError: string | null) {
    super(message)
    this.name = 'FileBackedRelayStartupError'
    this.relay = relay
    this.relayPid = relay.pid()
    this.cleanupError = cleanupError
  }
}

/** Extract the owned relay handle from a startup failure, if present. */
export function getFailedRelayHandle(error: unknown): FileBackedRelayHandle | null {
  if (error instanceof FileBackedRelayStartupError) return error.relay
  const relay = (error as { relay?: unknown } | null)?.relay
  if (
    relay &&
    typeof relay === 'object' &&
    typeof (relay as FileBackedRelayHandle).isRunning === 'function' &&
    typeof (relay as FileBackedRelayHandle).close === 'function'
  ) {
    return relay as FileBackedRelayHandle
  }
  return null
}

const READY_DEFAULT_MS = 30000
const STOP_DEFAULT_MS = 10000
const KILL_GRACE_MS = 5000
const HEALTH_POLL_MS = 250

export const HEALTH_REQUEST_MAX_MS = 5000
export const HEALTH_MAX_BYTES = 16384

/**
 * Documented maximum for every relay timeout input/deadline. Bounded for the
 * test lifecycle (matches the 300s E2E spec budget); larger budgets would
 * outlive the owning test and mask hangs.
 */
export const RELAY_TIMEOUT_MAX_MS = 300000

/** Reject NaN/Infinity/zero/negative/unbounded timeouts before any wait loop. */
export function validateRelayTimeoutMs(label: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > RELAY_TIMEOUT_MAX_MS) {
    throw new Error(
      `sync-relay-process: ${label} must be a finite positive timeout in ms (1..${RELAY_TIMEOUT_MAX_MS}), got ${String(value)}`
    )
  }
  return value
}

/**
 * Module-global owned-relay registry lives in run-ownership (ABI-neutral) so
 * the Electron fixture teardown can enforce the fail-closed root gate without
 * importing this implementation module. The wrappers below delegate to that
 * single registry; this module registers every spawned/failed handle there
 * and unregisters only after close() fully resolves.
 */

/** True when any tracked relay handle still owns a live child. */
export function hasLiveRelayChild(): boolean {
  return hasLiveOwnedRelayChild()
}

/** True while any tracked relay handle is unresolved (not yet closed), live or not. */
export function hasUnresolvedRelayCleanup(): boolean {
  return hasUnresolvedOwnedRelayCleanup()
}

/**
 * Fail-closed gate for root teardown: throws while any owned relay handle is
 * unresolved (child live, artifacts uncleaned, or close() not yet called).
 * Stricter than {@link assertNoLiveRelayChild}: a reaped-but-uncleaned
 * startup-failure handle still blocks root removal so its bundle/DB
 * artifacts are never deleted out from under it.
 */
export function assertNoUnresolvedRelayCleanup(label = 'owned root removal'): void {
  assertNoUnresolvedOwnedRelayCleanup(label)
}

/** Fail-closed gate for root teardown: throws while any owned relay child lives. */
export function assertNoLiveRelayChild(label = 'owned root removal'): void {
  assertNoLiveOwnedRelayChild(label)
}

function uniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Resolve the repo root from the runner cwd (both Vitest and Playwright run at the root). */
function resolveRepoRoot(): string {
  const candidate = process.cwd()
  try {
    const stat = fs.lstatSync(candidate)
    if (stat.isDirectory() && !stat.isSymbolicLink() && fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate)
    }
  } catch {
    // fall through to the fail-closed error below
  }
  throw new Error('sync-relay-process: cannot resolve repository root')
}

/** Locate the repo esbuild binary without importing bundler modules. */
function resolveEsbuildBin(repoRoot: string): string {
  const direct = path.join(repoRoot, 'node_modules', '.bin', 'esbuild')
  if (fs.existsSync(direct)) return direct
  throw new Error('sync-relay-process: esbuild binary not found (expected node_modules/.bin/esbuild)')
}

function resolveElectronBinary(repoRoot: string): string {
  // String path only; never loads a native binding in the runner. Playwright
  // loads this utility CJS-transformed, where the bare require (same as the
  // Electron fixture) resolves the binary path. Vitest loads it as ESM,
  // where require is undefined and createRequire anchored at the repo
  // package.json provides the same resolution.
  const runnerRequire: NodeRequire =
    typeof require !== 'undefined' ? require : createRequire(path.join(repoRoot, 'package.json'))
  const electronPath = runnerRequire('electron') as string
  if (!electronPath || typeof electronPath !== 'string') {
    throw new Error('sync-relay-process: electron binary path missing')
  }
  return electronPath
}

/** Bundle the production relay server verbatim to a temp CJS launcher. */
function bundleRelayServer(repoRoot: string, bundlePath: string): void {
  const serverTs = path.join(repoRoot, 'scripts', 'sync-relay', 'server.ts')
  if (!fs.existsSync(serverTs)) throw new Error('sync-relay-process: production relay server.ts missing')
  const esbuildBin = resolveEsbuildBin(repoRoot)
  const result = spawnSync(
    esbuildBin,
    [
      serverTs,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--external:better-sqlite3',
      '--external:electron',
      `--outfile=${bundlePath}`,
      '--log-level=warning'
    ],
    { timeout: 60000, encoding: 'utf8' }
  )
  if (result.error) throw new Error('sync-relay-process: relay bundling failed to spawn')
  if (result.status !== 0) throw new Error('sync-relay-process: relay bundling failed')
  if (!fs.existsSync(bundlePath)) throw new Error('sync-relay-process: relay bundle missing after build')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  validateRelayTimeoutMs('waitForExit timeoutMs', timeoutMs)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true
    await sleep(100)
  }
  return child.exitCode !== null || child.signalCode !== null
}

/** Bounded body read: rejects oversized responses before JSON parsing. */
async function readHealthBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared !== null && declared.trim() !== '') {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`health response oversized (content-length ${declared})`)
    }
  }
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('health response oversized')
    return text
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          try {
            await reader.cancel()
          } catch {}
          throw new Error('health response oversized')
        }
        chunks.push(value)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return Buffer.from(merged).toString('utf8')
}

export async function fetchRelayHealthOnce(endpoint: string, perRequestMs: number): Promise<void> {
  validateRelayTimeoutMs('perRequestMs', perRequestMs)
  const boundedMs = Math.max(1, Math.min(perRequestMs, HEALTH_REQUEST_MAX_MS))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), boundedMs)
  try {
    const res = await fetch(`${endpoint}/health`, { signal: controller.signal })
    if (res.status !== 200) throw new Error(`status ${res.status}`)
    const text = await readHealthBodyCapped(res, HEALTH_MAX_BYTES)
    let body: { ok?: unknown }
    try {
      body = JSON.parse(text) as { ok?: unknown }
    } catch {
      throw new Error('health body is not valid JSON')
    }
    if (body?.ok !== true) throw new Error('health body missing {ok:true}')
  } finally {
    clearTimeout(timer)
  }
}

export async function waitForRelayHealth(endpoint: string, timeoutMs: number): Promise<void> {
  validateRelayTimeoutMs('waitForRelayHealth timeoutMs', timeoutMs)
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      await fetchRelayHealthOnce(endpoint, remaining)
      return
    } catch (e) {
      lastError = String((e as Error).message).slice(0, 120)
    }
    const after = deadline - Date.now()
    if (after <= 0) break
    await sleep(Math.min(HEALTH_POLL_MS, after))
  }
  throw new Error(`sync-relay-process: health readiness timeout (${lastError})`)
}

function validateArtifactFileName(name: string, label: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`sync-relay-process: ${label} must be a non-empty file name`)
  }
  if (name.length > 255) throw new Error(`sync-relay-process: ${label} too long`)
  if (name.includes('\0')) throw new Error(`sync-relay-process: ${label} contains NUL`)
  if (path.isAbsolute(name)) throw new Error(`sync-relay-process: ${label} must not be absolute`)
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`sync-relay-process: ${label} must not contain path separators`)
  }
  if (name === '.' || name === '..') throw new Error(`sync-relay-process: ${label} must not be dot entry`)
  if (path.basename(name) !== name) throw new Error(`sync-relay-process: ${label} must be a bare file name`)
  if (/(^|\.)\.\.(\.|$)/.test(name)) throw new Error(`sync-relay-process: ${label} must not contain traversal`)
  return name
}

/** Every derived artifact must resolve to a direct child of the owned root. */
function assertDirectChildOfRoot(ownedTmpRoot: string, target: string, label: string): void {
  const resolved = path.resolve(target)
  const relative = path.relative(ownedTmpRoot, resolved)
  if (relative === '' || path.isAbsolute(relative) || relative.startsWith('..') || relative.includes(path.sep)) {
    throw new Error(`sync-relay-process: ${label} escapes the owned root`)
  }
}

/** Direct-child plus symlink/parent reality check for derived artifacts. */
function assertArtifactInsideRoot(ownedTmpRoot: string, target: string, label: string): void {
  assertDirectChildOfRoot(ownedTmpRoot, target, label)
  try {
    const existing = fs.lstatSync(path.resolve(target))
    if (existing.isSymbolicLink()) throw new Error(`sync-relay-process: ${label} must not be a symlink`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  try {
    const parentReal = fs.realpathSync(path.dirname(path.resolve(target)))
    if (parentReal !== ownedTmpRoot) {
      throw new Error(`sync-relay-process: ${label} parent escapes the owned root`)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** Every file the relay owns beneath the root: bundle, DB, and DB sidecars. */
function relayArtifactTargets(bundlePath: string, dbPath: string): string[] {
  return [bundlePath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
}

/** Containment/symlink gate for all relay artifacts (lstat-based, never follows). */
function assertAllArtifactsInsideRoot(ownedTmpRoot: string, bundlePath: string, dbPath: string): void {
  assertArtifactInsideRoot(ownedTmpRoot, bundlePath, 'relay bundle')
  assertArtifactInsideRoot(ownedTmpRoot, dbPath, 'relay DB')
  for (const suffix of ['-wal', '-shm', '-journal'] as const) {
    assertArtifactInsideRoot(ownedTmpRoot, `${dbPath}${suffix}`, `relay DB ${suffix}`)
  }
}

/** lstat-based existence probe: true for files, dirs, and dangling symlinks. */
function lstatExists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

function removeIfExists(target: string): void {
  try {
    // lstat (not existsSync) so a dangling symlink is detected and unlinked
    // via rmSync without ever being followed.
    try {
      fs.lstatSync(target)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    fs.rmSync(target, { force: true })
  } catch (e) {
    throw new Error(`sync-relay-process: cleanup failed (${(e as Error).message.slice(0, 120)})`)
  }
}

/**
 * Effective port-continuity guard for restart: the expected pinned port must
 * be captured BEFORE assigning the new child's returned port.
 */
export function assertRestartPortContinuity(expectedPort: number, actualPort: number): void {
  if (actualPort !== expectedPort) {
    throw new Error(
      `sync-relay-process: restarted relay bound an unexpected port (expected ${expectedPort}, got ${actualPort})`
    )
  }
}

export async function startFileBackedRelay(options: FileBackedRelayOptions): Promise<FileBackedRelayHandle> {
  if (!options || typeof options !== 'object') throw new Error('startFileBackedRelay requires options')
  const ownedTmpRoot = validateOwnedRoot(options.ownedTmpRoot)
  const token = options.token
  if (!token || typeof token !== 'string') throw new Error('startFileBackedRelay requires a non-empty token')
  const readyTimeoutMs = validateRelayTimeoutMs('readyTimeoutMs', options.readyTimeoutMs ?? READY_DEFAULT_MS)
  const stopTimeoutMs = validateRelayTimeoutMs('stopTimeoutMs', options.stopTimeoutMs ?? STOP_DEFAULT_MS)
  const suffix = uniqueSuffix()
  const repoRoot = resolveRepoRoot()
  const electronBinary = resolveElectronBinary(repoRoot)
  const nodeModulesPath = path.join(repoRoot, 'node_modules')
  if (options.bundleFileName !== undefined) validateArtifactFileName(options.bundleFileName, 'bundleFileName')
  if (options.dbFileName !== undefined) validateArtifactFileName(options.dbFileName, 'dbFileName')
  const bundlePath = path.join(ownedTmpRoot, options.bundleFileName ?? `sync-relay-bundle-${suffix}.cjs`)
  const dbPath = path.join(ownedTmpRoot, options.dbFileName ?? `sync-relay-${suffix}.db`)
  assertAllArtifactsInsideRoot(ownedTmpRoot, bundlePath, dbPath)

  bundleRelayServer(repoRoot, bundlePath)
  assertAllArtifactsInsideRoot(ownedTmpRoot, bundlePath, dbPath)

  let child: ChildProcess | null = null
  let boundPort: number | null = null
  let endpoint = 'http://127.0.0.1:0'
  const state = { closed: false }
  const startDeadlineHolder = { deadline: 0 }

  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TMPDIR: ownedTmpRoot,
    TMP: ownedTmpRoot,
    TEMP: ownedTmpRoot,
    NODE_PATH: nodeModulesPath
  }

  /** Best-effort owned-child termination after a failed start; ownership is retained on failure. */
  async function killAfterFailedStart(proc: ChildProcess): Promise<string | null> {
    const pid = proc.pid
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
      if (child === proc) child = null
      return null
    } catch (e) {
      return String((e as Error).message).slice(0, 200)
    }
  }

  async function startChild(requestedPort: number): Promise<{ endpoint: string; port: number }> {
    const proc = spawn(
      electronBinary,
      [bundlePath, '--port', String(requestedPort), '--db', dbPath, '--token', token],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    // Retain ownership immediately so every startup/readiness failure can
    // stop/escalate the exact owned child before rejecting (fail-closed, no orphan).
    child = proc
    let stdout = ''
    let stderr = ''
    const stdoutRemaining = startDeadlineHolder.deadline - Date.now()
    const stdoutBudget = Number.isFinite(stdoutRemaining) && stdoutRemaining > 0 ? stdoutRemaining : 1
    const portPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`sync-relay-process: relay stdout readiness timeout (stderr: ${stderr.slice(-500)})`)),
        stdoutBudget
      )
      const onData = (chunk: Buffer): void => {
        stdout += chunk.toString('utf8')
        if (stdout.length > 65536) stdout = stdout.slice(-65536)
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)
        if (match) {
          clearTimeout(timer)
          cleanup()
          resolve(Number(match[1]))
        }
      }
      const onStderr = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8')
        if (stderr.length > 65536) stderr = stderr.slice(-65536)
      }
      const onExit = (_code: number | null, _signal: NodeJS.Signals | null): void => {
        clearTimeout(timer)
        cleanup()
        reject(new Error(`sync-relay-process: relay child exited before readiness (stderr: ${stderr.slice(-500)})`))
      }
      const onError = (err: Error): void => {
        clearTimeout(timer)
        cleanup()
        reject(new Error(`sync-relay-process: relay child spawn failed (${err.message.slice(0, 200)})`))
      }
      const cleanup = (): void => {
        proc.stdout?.removeListener('data', onData)
        proc.stderr?.removeListener('data', onStderr)
        proc.removeListener('exit', onExit)
        proc.removeListener('error', onError)
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onStderr)
      proc.on('exit', onExit)
      proc.on('error', onError)
    })
    let port: number
    try {
      port = await portPromise
    } catch (e) {
      const cleanupErr = await killAfterFailedStart(proc)
      const detail = String((e as Error).message).slice(0, 300)
      throw { detail, cleanupErr, phase: 'startup' as const }
    }
    const nextEndpoint = `http://127.0.0.1:${port}`
    const remaining = startDeadlineHolder.deadline - Date.now()
    if (remaining <= 0) {
      const cleanupErr = await killAfterFailedStart(proc)
      throw {
        detail: 'sync-relay-process: readiness budget exhausted before health check',
        cleanupErr,
        phase: 'readiness' as const
      }
    }
    try {
      await waitForRelayHealth(nextEndpoint, remaining)
    } catch (e) {
      const cleanupErr = await killAfterFailedStart(proc)
      const detail = String((e as Error).message).slice(0, 300)
      throw { detail, cleanupErr, phase: 'readiness' as const }
    }
    return { endpoint: nextEndpoint, port }
  }

  async function stopChild(): Promise<void> {
    const proc = child
    if (!proc) return
    const pid = proc.pid
    if (proc.exitCode !== null || proc.signalCode !== null) {
      child = null
      return
    }
    // Exact owned-PID signal only; never a broad process kill.
    try {
      proc.kill('SIGTERM')
    } catch {
      throw new Error(`sync-relay-process: SIGTERM failed for owned relay PID ${pid}`)
    }
    const exited = await waitForExit(proc, stopTimeoutMs)
    if (!exited) {
      try {
        proc.kill('SIGKILL')
      } catch {
        throw new Error(`sync-relay-process: SIGKILL failed for owned relay PID ${pid}`)
      }
      const killed = await waitForExit(proc, KILL_GRACE_MS)
      if (!killed) throw new Error(`sync-relay-process: owned relay PID ${pid} survived SIGKILL`)
    }
    child = null
  }

  function buildHandle(): FileBackedRelayHandle {
    const handle: FileBackedRelayHandle = {
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
        if (state.closed) throw new Error('sync-relay-process: handle is closed')
        await stopChild()
      },
      restart: async () => {
        if (state.closed) throw new Error('sync-relay-process: handle is closed')
        if (boundPort === null || boundPort <= 0) throw new Error('sync-relay-process: no bound port to restart on')
        await stopChild()
        startDeadlineHolder.deadline = Date.now() + readyTimeoutMs
        const expectedPort = boundPort
        // Single-owner restart: reuse the already-tracked handle. A raw
        // startChild failure is wrapped to carry THIS handle (not a second
        // registered handle) so cleanup closes one owned handle and the
        // global registry never holds a hidden second entry.
        let next: { endpoint: string; port: number }
        try {
          next = await startChild(expectedPort)
        } catch (e) {
          if (e && typeof e === 'object' && 'phase' in (e as Record<string, unknown>)) {
            const { detail, cleanupErr } = e as { detail: string; cleanupErr: string | null }
            let live = true
            try {
              live = handle.isRunning()
            } catch {
              live = true
            }
            const base = live
              ? `sync-relay-process: startup failed with owned child still live; handle retained for retry; ${detail}`
              : cleanupErr
                ? `sync-relay-process: startup failed and owned child could not be reaped (${cleanupErr}); ${detail}`
                : `sync-relay-process: startup failed; owned child reaped; ${detail}`
            throw new FileBackedRelayStartupError(
              cleanupErr && live ? `${base} (cleanup: ${cleanupErr})` : base,
              handle,
              cleanupErr
            )
          }
          throw e
        }
        boundPort = next.port
        endpoint = next.endpoint
        assertRestartPortContinuity(expectedPort, next.port)
      },
      close: async () => {
        if (state.closed) return
        // Fail-closed: prove child termination BEFORE touching artifacts. On
        // termination failure artifacts are preserved and the handle stays
        // open so the caller can retry close().
        try {
          await stopChild()
        } catch (e) {
          throw new Error(
            `sync-relay-process: close could not prove child termination; artifacts preserved for retry (${String((e as Error).message).slice(0, 200)})`
          )
        }
        if (child !== null) {
          throw new Error('sync-relay-process: close could not prove child termination; artifacts preserved for retry')
        }
        const errors: string[] = []
        try {
          // Re-validate every sidecar with lstat semantics before touching
          // artifacts: a symlink swapped in after start must fail closed here
          // instead of being followed or unlinked blindly.
          assertAllArtifactsInsideRoot(ownedTmpRoot, bundlePath, dbPath)
        } catch (e) {
          errors.push(String((e as Error).message).slice(0, 200))
        }
        if (errors.length === 0) {
          try {
            for (const target of relayArtifactTargets(bundlePath, dbPath)) removeIfExists(target)
          } catch (e) {
            errors.push(String((e as Error).message).slice(0, 200))
          }
        }
        for (const target of relayArtifactTargets(bundlePath, dbPath)) {
          try {
            // lstat-based: a surviving dangling symlink counts as survived.
            if (lstatExists(target)) errors.push(`artifact survived cleanup: ${path.basename(target)}`)
          } catch {
            errors.push(`cleanup verification failed: ${path.basename(target)}`)
          }
        }
        if (errors.length > 0) throw new Error(`sync-relay-process: close failed (${errors.join('; ')})`)
        state.closed = true
        unregisterOwnedRelayHandle(handle)
      }
    }
    return handle
  }

  async function startChildWithOwnedErrors(requestedPort: number): Promise<{ endpoint: string; port: number }> {
    try {
      return await startChild(requestedPort)
    } catch (e) {
      if (e && typeof e === 'object' && 'phase' in (e as Record<string, unknown>)) {
        const { detail, cleanupErr } = e as { detail: string; cleanupErr: string | null }
        // Retain an owned handle so the caller/finalizer can retry stop/close;
        // the live child (if any) is also globally registered so root teardown
        // blocks deletion while it lives. Never reject with an untracked child.
        const failedHandle = buildHandle()
        registerOwnedRelayHandle(failedHandle)
        const live = failedHandle.isRunning()
        const base = live
          ? `sync-relay-process: startup failed with owned child still live; handle retained for retry; ${detail}`
          : cleanupErr
            ? `sync-relay-process: startup failed and owned child could not be reaped (${cleanupErr}); ${detail}`
            : `sync-relay-process: startup failed; owned child reaped; ${detail}`
        throw new FileBackedRelayStartupError(
          cleanupErr && live ? `${base} (cleanup: ${cleanupErr})` : base,
          failedHandle,
          cleanupErr
        )
      }
      throw e
    }
  }

  // First start uses an ephemeral port; the bound port is then pinned so a
  // restart keeps the same endpoint for already-configured profiles. The total
  // startup/readiness budget is shared: health gets only the remaining time.
  startDeadlineHolder.deadline = Date.now() + readyTimeoutMs
  let first: { endpoint: string; port: number }
  try {
    first = await startChildWithOwnedErrors(0)
  } catch (e) {
    if (e instanceof FileBackedRelayStartupError && !e.relay.isRunning()) {
      // Child was reaped but bundle/DB artifacts remain inside the owned root;
      // the retained handle lets the caller close() them. Keep registration
      // so root teardown ordering stays observable until close() succeeds.
    }
    throw e
  }
  boundPort = first.port
  endpoint = first.endpoint

  const handle = buildHandle()
  registerOwnedRelayHandle(handle)
  return handle
}
