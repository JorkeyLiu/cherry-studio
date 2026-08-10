/**
 * Coordinator regression coverage for `runLane` (scripts/native-abi/run.ts).
 *
 * `runLane` composes `runLanePreparation` (prepare.ts), `finalizeOuterLane`
 * (finalize.ts), `executeProcess` (executor.ts), `maybeRestoreElectron`
 * (lanes.ts), and `releaseLock` (lock.ts) into the single explicit lane
 * coordinator. These tests exercise the real composition with injected
 * preparation seams (scripted resolver / lock / ensure), a fake `LockFs`
 * shared by the default release determinism, a fake `Effects` making the
 * Electron restoration deterministic (no real better-sqlite3 probe / rebuild),
 * and fake process executor seams. No real binding, subprocess, or rebuild is
 * involved.
 *
 * Behavior covered (LOCK-003/004/006/007 and the run.ts result contract):
 *  - nested: exited / signaled / spawn-error outcomes propagate verbatim with
 *    zero lock / ensure / restore / release calls;
 *  - lane conflict returns code 5 and never spawns or releases;
 *  - root-resolution and lock-acquire preparation failures return code 6 and
 *    never spawn or release;
 *  - outer happy path executes the child, restores then releases in order, and
 *    returns the child code;
 *  - outer env/cwd/argv propagation, nested env verbatim, outer child env
 *    carries the lease while preserving the base env;
 *  - target-lane-failure skips the child but still restores and releases for a
 *    local Node lane;
 *  - LOCK-006 precedence: child failure > restore failure > release failure;
 *  - LOCK-003 CI: the explicit `ci` option overrides `process.env.CI`, and a
 *    default `process.env.CI === 'true'` skips restoration.
 *  - ambient/caller `ELECTRON_RUN_AS_NODE` is stripped from the env passed to
 *    lane preparation and canonical child execution (nested spawn and outer
 *    lease env), the caller env is never mutated, every unrelated variable is
 *    preserved, and the controlled effects probe env stays outside the
 *    sanitizer contract (`stripElectronRunAsNode`).
 *
 * Additional coordinator regression coverage:
 *  - default preparation seam construction: `createPreparationSeams` +
 *    `createLockService` wire an injected lockFs into BOTH acquisition and
 *    release (only the ensure seam is injected, so no real native probe or
 *    rebuild runs);
 *  - run-level target-lane-failure with a failed restore and a failed release:
 *    the target preparation exit code stays authoritative and the restore-then-
 *    release order remains observable;
 *  - an omitted env defaults to process.env without mutating it — the lease is
 *    added only to the child copy;
 *  - restore-failure intent is explicit: the Electron probe fails and the
 *    rebuild fails with the exact `process.execPath not verified` diagnostic.
 *
 * Lifecycle signal guard coverage (SIGINT/SIGTERM across the whole run):
 *  - the single coordinator guard is installed before preparation and disposed
 *    in a top-level finally, so a signal during target ensure/rebuild, child
 *    execution, Electron restoration, or lock release can never terminate the
 *    coordinator before cleanup completes, and no handler leaks past the run;
 *  - a signal latched before the outer child starts skips the requested
 *    command: the finalizer reports a synthetic signaled outcome while
 *    restoration/release still run, and the conventional signal exit code
 *    wins;
 *  - a signal during the child run coexists with the executor's forwarding
 *    handlers: the child receives the forwarded signal, a signaled child stays
 *    authoritative, and both handler sets are cleaned;
 *  - a nested child that exits 0 after a captured signal yields the
 *    conventional signal exit code with the structured signal exposed, while a
 *    failing/signaled child stays authoritative;
 *  - a preserved target preparation failure stays authoritative over a signal
 *    captured during the failing ensure;
 *  - repeated signals retain the first one only and never re-run operations.
 */

import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROBE_MARKER, PROBE_MARKER_ENV, PROBE_MODULE_ENV, PROBE_TEST_SEAM_ENV } from '../constants'
import type { ProcessExecutorSeams, ProcessOutcome, SpawnedChild } from '../executor'
import {
  CHILD_SPAWN_ERROR_EXIT_CODE,
  RELEASE_FAILURE_EXIT_CODE,
  RESTORE_FAILURE_EXIT_CODE,
  TARGET_PREPARATION_FAILURE_EXIT_CODE
} from '../finalize'
import type { LaneEnsureResult } from '../lanes'
import { LEASE_ENV_NAME, leaseFromEnv, withLease } from '../lease'
import {
  defaultLockPath,
  type LaneId,
  type LockAcquireResult,
  type LockFs,
  type LockOwner,
  type LockReadResult,
  serializeLockFile
} from '../lock'
import {
  createLeaseInspector,
  createLockService,
  createPreparationSeams,
  type LaneEnsureService,
  type LockService,
  type RootResolver
} from '../prepare'
import {
  ELECTRON_RUN_AS_NODE_ENV,
  LANE_CONFLICT_EXIT_CODE,
  PREPARATION_FAILURE_EXIT_CODE,
  runLane,
  type RunLaneOptions,
  stripElectronRunAsNode
} from '../run'
import type {
  CheckReport,
  DirListing,
  Effects,
  ProbeResult,
  RebuildReport,
  RebuildRunResult,
  RuntimeInfo,
  SpawnResult
} from '../types'

// ---------------------------------------------------------------------------
// Deterministic fakes: a scripted child process, scripted process seams,
// an in-memory LockFs, scripted preparation services/resolver, and a fake
// Effects whose Electron restoration is fully scripted (no real probe/rebuild).
// ---------------------------------------------------------------------------

/** A registered parent-signal handler plus the function that removes it. */
interface SignalRegistration {
  handler: () => void
  unregister: () => void
}

class FakeChild extends EventEmitter implements SpawnedChild {
  pid: number | undefined
  /** Signals the executor forwarded to this child via `kill`. */
  killSignals: NodeJS.Signals[] = []

  constructor(pid?: number) {
    super()
    this.pid = pid
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) {
      this.killSignals.push(signal)
    }
    return true
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal)
  }

  fail(error: Error): void {
    this.emit('error', error)
  }
}

class FakeSeams implements ProcessExecutorSeams {
  spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  scriptedChild: FakeChild | null = null
  /** When set, the spawn auto-settles the scripted child on a microtask. */
  autoOutcome: ProcessOutcome | undefined
  readonly order?: string[]
  /**
   * When set, `spawn` marks this deferred so a test can await the exact moment
   * the child was spawned (the executor attaches its listeners and registers
   * its forwarding handlers synchronously right after, before any microtask).
   */
  spawnNotify: Deferred<void> | undefined
  /** Registered parent signal handlers (signal → handler + its unregister). */
  private readonly signalHandlers = new Map<NodeJS.Signals, SignalRegistration[]>()

  constructor(order?: string[]) {
    this.order = order
  }

  spawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedChild {
    this.spawnCalls.push({ command, args, options })
    this.order?.push('child')
    const child = this.scriptedChild
    if (child === null) {
      throw new Error('FakeSeams: no scripted child')
    }
    this.scriptedChild = null
    this.spawnNotify?.markStarted()
    const outcome = this.autoOutcome
    if (outcome !== undefined) {
      this.autoOutcome = undefined
      // The executor attaches its close/error listeners synchronously after the
      // spawn returns, so a microtask always settles an already-observed child.
      queueMicrotask(() => {
        if (outcome.kind === 'exited') {
          child.close(outcome.code, null)
        } else if (outcome.kind === 'signaled') {
          child.close(null, outcome.signal)
        } else {
          const error = new Error(outcome.message) as NodeJS.ErrnoException
          if (outcome.code !== undefined) {
            error.code = outcome.code
          }
          child.fail(error)
        }
      })
    }
    return child
  }

  onSignal(signal: NodeJS.Signals, handler: () => void): () => void {
    let handlers = this.signalHandlers.get(signal)
    if (handlers === undefined) {
      handlers = []
      this.signalHandlers.set(signal, handlers)
    }
    let unregistered = false
    const entry: SignalRegistration = {
      handler,
      unregister: () => {
        if (unregistered) {
          return
        }
        unregistered = true
        const list = this.signalHandlers.get(signal)
        if (list !== undefined) {
          const index = list.indexOf(entry)
          if (index !== -1) {
            list.splice(index, 1)
          }
          if (list.length === 0) {
            this.signalHandlers.delete(signal)
          }
        }
      }
    }
    handlers.push(entry)
    return entry.unregister
  }

  /** Dispatch a signal to every currently-registered handler (registration order). */
  dispatch(signal: NodeJS.Signals): void {
    const handlers = this.signalHandlers.get(signal)
    if (handlers === undefined) {
      return
    }
    for (const { handler } of [...handlers]) {
      handler()
    }
  }

  /** Every signal that still has at least one registered handler. */
  registeredSignals(): NodeJS.Signals[] {
    return [...this.signalHandlers.keys()]
  }

  /** Total number of registered handlers. */
  handlerCount(): number {
    let count = 0
    for (const list of this.signalHandlers.values()) {
      count += list.length
    }
    return count
  }
}

class FakeLockFs implements LockFs {
  files = new Map<string, string>()
  removeErrors = new Map<string, string>()
  removedPaths: string[] = []
  readonly order?: string[]
  /** When set, `removeFile` first dispatches this signal (deterministic mid-release dispatch). */
  dispatchOnRemove: NodeJS.Signals | undefined
  /** Signal dispatcher wired by the test to the `FakeSeams` registry. */
  signalDispatcher: ((signal: NodeJS.Signals) => void) | undefined

  constructor(order?: string[]) {
    this.order = order
  }

  createExclusive(p: string, content: string): 'created' | 'exists' | string {
    if (this.files.has(p)) {
      return 'exists'
    }
    this.files.set(p, content)
    return 'created'
  }

  readFile(p: string): LockReadResult {
    const content = this.files.get(p)
    return content === undefined ? { status: 'absent' } : { status: 'ok', content }
  }

  removeFile(p: string): string | undefined {
    this.order?.push('release')
    if (this.dispatchOnRemove !== undefined && this.signalDispatcher !== undefined) {
      this.signalDispatcher(this.dispatchOnRemove)
    }
    const error = this.removeErrors.get(p)
    if (error !== undefined) {
      this.removeErrors.delete(p)
      return error
    }
    if (this.files.delete(p)) {
      this.removedPaths.push(p)
    }
    return undefined
  }

  isPidAlive(): boolean {
    return true
  }

  async sleep(): Promise<void> {
    return undefined
  }

  now(): number {
    return 0
  }

  randomToken(): string {
    return 'tok-fs'
  }
}

class FakeEffects implements Effects {
  /** When false the Electron restore check fails and its rebuild fails fast. */
  checkOk = true
  electronProbeCalls = 0
  readonly order?: string[]
  /** When true, the Electron rebuild preconditions pass for the fake execPath. */
  execPathExists = false
  /**
   * When set, `rebuildElectron` awaits this gate (a deferred) so a test can
   * deterministically dispatch a signal while the Electron restore is
   * in-flight, then resolve the rebuild. The started marker resolves as soon
   * as the gate is reached.
   */
  rebuildGate: Deferred<RebuildRunResult> | undefined

  constructor(order?: string[]) {
    this.order = order
  }

  runtimeInfo(): RuntimeInfo {
    return {
      runtime: 'node',
      nodeVersion: '24.11.1',
      modulesAbi: 137,
      platform: 'darwin',
      arch: 'arm64',
      execPath: '/usr/local/bin/node'
    }
  }

  readJson(): unknown {
    return { version: '12.11.1' }
  }

  readFile(): string | undefined {
    return undefined
  }

  realpath(p: string): string {
    return p
  }

  exists(p: string): boolean {
    // The fake execPath only "exists" when the test opts into the rebuild
    // preconditions (every other path stays absent, preserving the default
    // restore-failure diagnostics of the other suites).
    return this.execPathExists && p === '/usr/local/bin/node'
  }

  listDir(): DirListing {
    return { ok: true, entries: [] }
  }

  removeFile(): string | undefined {
    return undefined
  }

  removeDir(): string | undefined {
    return undefined
  }

  resolvePackageJsonPath(pkg: string): string | undefined {
    return `/repo/node_modules/${pkg}/package.json`
  }

  resolveFilePath(): string | undefined {
    return undefined
  }

  probeNodeBinding(): ProbeResult {
    return { ok: true, sqlOk: true }
  }

  electronBinPath(): string | undefined {
    return '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  }

  electronVersion(): string | undefined {
    return '41.2.1'
  }

  spawnElectronProbe(): SpawnResult {
    this.electronProbeCalls += 1
    this.order?.push('restore')
    if (this.checkOk) {
      return {
        code: 0,
        stdout: `${PROBE_MARKER} ${JSON.stringify({
          ok: true,
          runtime: 'electron',
          version: '41.2.1',
          nodeVersion: '24.11.1',
          abi: 145,
          platform: 'darwin',
          arch: 'arm64',
          sqlOk: true
        })}`,
        stderr: ''
      }
    }
    return {
      code: 1,
      stdout: `${PROBE_MARKER} ${JSON.stringify({
        ok: false,
        runtime: 'electron',
        version: '41.2.1',
        nodeVersion: '24.11.1',
        abi: 145,
        platform: 'darwin',
        arch: 'arm64',
        sqlOk: false,
        error: 'binding does not load under Electron'
      })}`,
      stderr: ''
    }
  }

  pnpmVersion(): string | undefined {
    return '10.27.0'
  }

  nodeGypJsPath(): string | undefined {
    return undefined
  }

  nodeDir(): string | undefined {
    return undefined
  }

  runNodeGyp(): SpawnResult {
    throw new Error('FakeEffects: runNodeGyp must never be called')
  }

  rebuildElectron(): Promise<RebuildRunResult> {
    const gate = this.rebuildGate
    if (gate === undefined) {
      throw new Error('FakeEffects: rebuildElectron must never be called')
    }
    gate.markStarted()
    return gate.promise
  }

  projectRoot(): string {
    return '/repo'
  }

  probePath(): string {
    return '/repo/scripts/native-abi/probe.cjs'
  }
}

class FakeLockService implements LockService {
  acquireResults: LockAcquireResult[] = []
  acquireErrors: unknown[] = []
  acquireCalls: Array<{ checkoutRoot: string; lane: LaneId; pid?: number; token?: string }> = []

  async acquire(opts: {
    checkoutRoot: string
    lane: LaneId
    pid?: number
    token?: string
  }): Promise<LockAcquireResult> {
    this.acquireCalls.push(opts)
    const nextErr = this.acquireErrors.shift()
    if (nextErr !== undefined) {
      throw nextErr
    }
    const next = this.acquireResults.shift()
    if (next === undefined) {
      throw new Error('FakeLockService: no scripted acquire result')
    }
    return next
  }
}

class FakeEnsureService implements LaneEnsureService {
  ensureResults: LaneEnsureResult[] = []
  ensureCalls: LaneId[] = []
  /**
   * When set, `ensure` awaits this gate (a deferred) so a test can
   * deterministically dispatch a signal while the target lane ensure/rebuild
   * is in-flight, then resolve it with the scripted result. The started marker
   * resolves as soon as the gate is reached.
   */
  ensureGate: Deferred<LaneEnsureResult> | undefined

  async ensure(lane: LaneId): Promise<LaneEnsureResult> {
    this.ensureCalls.push(lane)
    const gate = this.ensureGate
    if (gate !== undefined) {
      this.ensureGate = undefined
      gate.markStarted()
      return gate.promise
    }
    const next = this.ensureResults.shift()
    if (next === undefined) {
      throw new Error('FakeEnsureService: no scripted ensure result')
    }
    return next
  }
}

class FakeResolver implements RootResolver {
  checkoutRoot: string | undefined = CHECKOUT

  resolveCheckoutRoot(explicit: string | undefined): string | undefined {
    return explicit ?? this.checkoutRoot
  }
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const CHECKOUT = '/repo/checkout'
const COMMAND = '/usr/bin/runner'
const ARGS = ['--lane', 'node']
const LOCK_PATH = defaultLockPath(CHECKOUT)

/**
 * Minimal deferred: `promise` resolves through `resolve`; `markStarted` and
 * `started` let a test await the exact moment the gated seam was reached.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  started: Promise<void>
  markStarted: () => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let markStarted!: () => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  const started = new Promise<void>((res) => {
    markStarted = res
  })
  return { promise, resolve, started, markStarted }
}

function owner(overrides: Partial<LockOwner> = {}): LockOwner {
  return {
    pid: 4242,
    token: 'tok-outer',
    lane: 'node',
    checkoutRoot: CHECKOUT,
    timestamp: 1,
    ...overrides
  }
}

function inheritedEnv(owner_ = owner()): NodeJS.ProcessEnv {
  return withLease({ PATH: '/usr/bin' }, { version: 1, owner: owner_ })
}

function acquired(checkoutRoot = CHECKOUT, ownerOverrides: Partial<LockOwner> = {}): LockAcquireResult {
  return {
    acquired: true,
    owner: owner({ checkoutRoot, ...ownerOverrides }),
    lockPath: defaultLockPath(checkoutRoot)
  }
}

function lockFailure(
  reason: 'locked' | 'timeout' | 'error',
  detail: { error?: string; checkoutRoot?: string } = {}
): LockAcquireResult {
  const root = detail.checkoutRoot ?? CHECKOUT
  if (reason === 'error') {
    return {
      acquired: false,
      reason: 'error',
      error: detail.error ?? 'writeFileSync: EACCES',
      lockPath: defaultLockPath(root)
    }
  }
  return { acquired: false, reason, owner: owner({ checkoutRoot: root }), lockPath: defaultLockPath(root) }
}

function checkReport(lane: LaneId, ok: boolean, failures: string[] = []): CheckReport {
  return {
    target: lane,
    ok,
    runtimeName: lane === 'node' ? 'node' : 'electron',
    runtimeVersion: lane === 'node' ? '24.11.1' : '41.2.1',
    abi: lane === 'node' ? 137 : 145,
    platform: 'darwin',
    arch: 'arm64',
    markerState: 'ignored',
    sqlVerified: ok,
    failures
  }
}

function rebuildReport(lane: LaneId, ok: boolean, failures: string[] = []): RebuildReport {
  return {
    target: lane,
    ok,
    nodeVersion: '24.11.1',
    abi: 137,
    platform: 'darwin',
    arch: 'arm64',
    markerBefore: [],
    toolOutput: [],
    failures
  }
}

function ensureOk(lane: LaneId, rebuilt = false): LaneEnsureResult {
  const good = checkReport(lane, true)
  if (rebuilt) {
    return {
      status: 'ok',
      lane,
      rebuilt: true,
      check: checkReport(lane, false, ['node ABI 137 missing']),
      rebuild: rebuildReport(lane, true),
      verify: good
    }
  }
  return { status: 'ok', lane, rebuilt: false, check: good, verify: good }
}

function ensureRebuildFailed(lane: LaneId): LaneEnsureResult {
  return {
    status: 'rebuild-failed',
    lane,
    check: checkReport(lane, false, ['check: node ABI 137 missing']),
    rebuild: rebuildReport(lane, false, ['node-gyp exited with code 1', 'EACCES: permission denied'])
  }
}

class Harness {
  order: string[] = []
  lock = new FakeLockService()
  ensure = new FakeEnsureService()
  resolver = new FakeResolver()
  lease = createLeaseInspector()
  lockFs = new FakeLockFs(this.order)
  effects = new FakeEffects(this.order)
  seams = new FakeSeams(this.order)

  options(overrides: Partial<RunLaneOptions> = {}): RunLaneOptions {
    return {
      lane: 'node',
      command: COMMAND,
      args: ARGS,
      env: { PATH: '/usr/bin', FOO: 'bar' },
      cwd: '/custom/cwd',
      preparationSeams: {
        resolver: this.resolver,
        lease: this.lease,
        lock: this.lock,
        ensure: this.ensure
      },
      lockFs: this.lockFs,
      effects: this.effects,
      processSeams: this.seams,
      ...overrides
    }
  }

  /** Seed a lock file whose owner matches the acquisition token (release guard passes). */
  seedLock(token: string): void {
    this.lockFs.files.set(LOCK_PATH, serializeLockFile({ version: 1, owner: owner({ token }) }))
  }

  /** Script the outer-preparation happy result (acquire + target ensure + lock file). */
  scriptOuter(
    overrides: { token?: string; ensure?: LaneEnsureResult; checkOk?: boolean; releaseError?: string } = {}
  ): void {
    const token = overrides.token ?? 'tok-acq'
    this.lock.acquireResults.push(acquired(CHECKOUT, { token }))
    this.ensure.ensureResults.push(overrides.ensure ?? ensureOk('node'))
    this.seedLock(token)
    if (overrides.checkOk !== undefined) {
      this.effects.checkOk = overrides.checkOk
    }
    if (overrides.releaseError !== undefined) {
      this.lockFs.removeErrors.set(LOCK_PATH, overrides.releaseError)
    }
  }

  /** Script the target-lane-failure result (acquire + failing ensure + lock file). */
  scriptTargetLaneFailure(): void {
    const token = 'tok-acq'
    this.lock.acquireResults.push(acquired(CHECKOUT, { token }))
    this.ensure.ensureResults.push(ensureRebuildFailed('node'))
    this.seedLock(token)
  }
}

// ---------------------------------------------------------------------------

describe('stripElectronRunAsNode (canonical child env sanitizer)', () => {
  it('returns the input unchanged (same reference) when ELECTRON_RUN_AS_NODE is absent', () => {
    const env = { PATH: '/usr/bin', FOO: 'bar' }

    const sanitized = stripElectronRunAsNode(env)

    // Nothing to strip: the same reference is returned, so the caller env is
    // never copied or mutated and nested "verbatim" identity is preserved.
    expect(sanitized).toBe(env)
    expect(sanitized).toEqual({ PATH: '/usr/bin', FOO: 'bar' })
  })

  it('returns a copy without ELECTRON_RUN_AS_NODE, preserving every other key and never mutating the input', () => {
    const env = {
      PATH: '/usr/bin',
      FOO: 'bar',
      [ELECTRON_RUN_AS_NODE_ENV]: '1',
      // Probe-controlled vars stay untouched: the sanitizer only strips the
      // ambient launch hazard and never reaches the probe env contract
      // (effects.ts is the sole place ELECTRON_RUN_AS_NODE is valid).
      [PROBE_MARKER_ENV]: 'm',
      [PROBE_MODULE_ENV]: 'pkg',
      [PROBE_TEST_SEAM_ENV]: '1'
    }
    const before = { ...env }

    const sanitized = stripElectronRunAsNode(env)

    expect(sanitized).not.toBe(env)
    expect(sanitized[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined()
    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      FOO: 'bar',
      [PROBE_MARKER_ENV]: 'm',
      [PROBE_MODULE_ENV]: 'pkg',
      [PROBE_TEST_SEAM_ENV]: '1'
    })
    // The input object is untouched: the ambient variable stays on the caller env.
    expect(env).toEqual(before)
    expect(env[ELECTRON_RUN_AS_NODE_ENV]).toBe('1')
  })
})

describe('runLane — nested lease (LOCK-004)', () => {
  it('propagates an exited child outcome verbatim with zero lock/ensure/restore/release calls', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-nested', lane: 'node' }))
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 7 }

    const result = await runLane(h.options({ env }))

    expect(result.status).toBe('nested')
    if (result.status === 'nested') {
      expect(result.lane).toBe('node')
      expect(result.checkoutRoot).toBe(CHECKOUT)
      expect(result.lease.owner.token).toBe('tok-nested')
      expect(result.child).toEqual({ kind: 'exited', code: 7 })
      expect(result.exitCode).toBe(7)
    }
    // The child ran once under the inherited lease env, verbatim.
    expect(h.seams.spawnCalls).toHaveLength(1)
    expect(h.seams.spawnCalls[0].options.env).toBe(env)
    expect(h.seams.spawnCalls[0].options.cwd).toBe('/custom/cwd')
    expect(h.seams.spawnCalls[0].options.stdio).toBe('inherit')
    // Nothing else ran: no lock, no ensure, no restore, no release.
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual(['child'])
  })

  it('propagates a signaled child with its deterministic conventional exit code', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-nested', lane: 'node' }))
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'signaled', signal: 'SIGTERM', exitCode: 143 }

    const result = await runLane(h.options({ env }))

    expect(result.status).toBe('nested')
    if (result.status === 'nested') {
      expect(result.child).toEqual({ kind: 'signaled', signal: 'SIGTERM', exitCode: 143 })
      expect(result.exitCode).toBe(143)
    }
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual(['child'])
  })

  it('propagates a spawn error with CHILD_SPAWN_ERROR_EXIT_CODE and no cleanup', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-nested', lane: 'node' }))
    h.seams.scriptedChild = new FakeChild()
    h.seams.autoOutcome = { kind: 'spawn-error', message: 'spawn /no/such/executable ENOENT', code: 'ENOENT' }

    const result = await runLane(h.options({ env }))

    expect(result.status).toBe('nested')
    if (result.status === 'nested') {
      expect(result.child).toMatchObject({
        kind: 'spawn-error',
        message: 'spawn /no/such/executable ENOENT',
        code: 'ENOENT'
      })
      expect(result.exitCode).toBe(CHILD_SPAWN_ERROR_EXIT_CODE)
    }
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual(['child'])
  })

  it('strips an ambient ELECTRON_RUN_AS_NODE from the nested child spawn env while preserving the lease, other vars, and the caller env', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-nested', lane: 'node' }))
    env[ELECTRON_RUN_AS_NODE_ENV] = '1'
    const before = { ...env }
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ env }))

    expect(result.status).toBe('nested')
    if (result.status === 'nested') {
      expect(result.exitCode).toBe(0)
    }
    // The ambient variable never reaches the nested child; everything else —
    // including the inherited lease — is preserved on the spawn env.
    const childEnv = h.seams.spawnCalls[0].options.env
    expect(childEnv).toBeDefined()
    if (childEnv !== undefined) {
      expect(childEnv[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined()
      expect(childEnv.PATH).toBe('/usr/bin')
      expect(leaseFromEnv(childEnv)?.owner.token).toBe('tok-nested')
    }
    // The caller env is never mutated: the ambient variable stays on it.
    expect(env).toEqual(before)
    expect(env[ELECTRON_RUN_AS_NODE_ENV]).toBe('1')
  })
})

describe('runLane — lane conflict (LOCK-007)', () => {
  it('a valid same-checkout opposite-lane lease returns code 5 and never spawns or releases', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-electron', lane: 'electron' }))

    const result = await runLane(h.options({ lane: 'node', env }))

    expect(result.status).toBe('lane-conflict')
    if (result.status === 'lane-conflict') {
      expect(result.lane).toBe('node')
      expect(result.checkoutRoot).toBe(CHECKOUT)
      expect(result.lease.owner.lane).toBe('electron')
      expect(result.lease.owner.token).toBe('tok-electron')
      expect(result.exitCode).toBe(LANE_CONFLICT_EXIT_CODE)
    }
    // The lane is never switched and the lock is never touched: no child, no
    // acquire, no ensure, no restore, no release.
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual([])
  })

  it('conflicts in the reverse direction (node lease, electron lane)', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-node', lane: 'node' }))

    const result = await runLane(h.options({ lane: 'electron', env }))

    expect(result.status).toBe('lane-conflict')
    if (result.status === 'lane-conflict') {
      expect(result.lease.owner.lane).toBe('node')
      expect(result.exitCode).toBe(LANE_CONFLICT_EXIT_CODE)
    }
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.order).toEqual([])
  })
})

describe('runLane — preparation failures (exit code 6)', () => {
  it('an unresolvable checkout root fails with code 6 and never spawns or releases', async () => {
    const h = new Harness()
    h.resolver.checkoutRoot = undefined

    const result = await runLane(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (result.status === 'preparation-failure') {
      expect(result.reason.kind).toBe('root-resolution')
      expect(result.checkoutRoot).toBe('(unresolved)')
      expect(result.exitCode).toBe(PREPARATION_FAILURE_EXIT_CODE)
    }
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual([])
  })

  it('a locked/timeout lock acquisition fails with code 6 and never spawns or releases', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(lockFailure('timeout'))

    const result = await runLane(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (
      result.status === 'preparation-failure' &&
      result.reason.kind === 'lock-acquire' &&
      !result.reason.acquire.acquired
    ) {
      expect(result.reason.acquire.reason).toBe('timeout')
      expect(result.reason.acquire.lockPath).toBe(LOCK_PATH)
      expect(result.exitCode).toBe(PREPARATION_FAILURE_EXIT_CODE)
    }
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual([])
  })

  it('a rejecting lock acquisition fails with code 6, carrying the diagnostic', async () => {
    const h = new Harness()
    h.lock.acquireErrors.push(new Error('lock exploded'))

    const result = await runLane(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (result.status === 'preparation-failure' && result.reason.kind === 'lock-acquire-rejected') {
      expect(result.reason.error).toContain('lock exploded')
      expect(result.exitCode).toBe(PREPARATION_FAILURE_EXIT_CODE)
    }
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual([])
  })
})

describe('runLane — outer happy path', () => {
  it('executes the child, restores then releases in order, and returns the child code', async () => {
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
      expect(result.checkoutRoot).toBe(CHECKOUT)
      expect(result.owner.token).toBe('tok-acq')
      expect(result.token).toBe('tok-acq')
      expect(result.lockPath).toBe(LOCK_PATH)
      expect(result.ensure.status).toBe('ok')
      // Full finalizer statuses: the child ran, the restore performed ok, the
      // lock released exactly once through the injected lockFs.
      expect(result.finalize.child).toEqual({ ran: true, outcome: { kind: 'exited', code: 0 } })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
      expect(result.restoreDetail?.status).toBe('performed')
    }
    // One acquisition, one target-lane ensure, one restore probe, one release.
    expect(h.lock.acquireCalls).toEqual([{ checkoutRoot: CHECKOUT, lane: 'node', pid: undefined }])
    expect(h.ensure.ensureCalls).toEqual(['node'])
    expect(h.seams.spawnCalls).toHaveLength(1)
    expect(h.effects.electronProbeCalls).toBe(1)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    // Exact child → restore → release ordering.
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('propagates command, argv, cwd and the lease env while preserving the base env', async () => {
    const h = new Harness()
    h.scriptOuter()
    const base = { PATH: '/usr/bin', FOO: 'bar' }
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(
      h.options({
        lane: 'node',
        ci: false,
        command: '/usr/bin/runner',
        args: ['--lane', 'node', '--flag'],
        cwd: '/custom/cwd',
        env: base
      })
    )

    expect(result.status).toBe('outer')
    const call = h.seams.spawnCalls[0]
    expect(call.command).toBe('/usr/bin/runner')
    expect(call.args).toEqual(['--lane', 'node', '--flag'])
    expect(call.options.cwd).toBe('/custom/cwd')
    expect(call.options.stdio).toBe('inherit')
    // The child inherits the prepared lease env carrying the acquired owner,
    // with every base variable preserved.
    const childEnv = call.options.env
    expect(childEnv).toBeDefined()
    if (childEnv !== undefined) {
      const childLease = leaseFromEnv(childEnv)
      expect(childLease?.owner.token).toBe('tok-acq')
      expect(childLease?.owner.lane).toBe('node')
      expect(childLease?.owner.checkoutRoot).toBe(CHECKOUT)
      expect(childEnv.PATH).toBe('/usr/bin')
      expect(childEnv.FOO).toBe('bar')
    }
    // The caller's environment is never mutated: the lease is only on the child copy.
    expect(base[LEASE_ENV_NAME]).toBeUndefined()
  })

  it('defaults the child cwd to process.cwd() when none is supplied', async () => {
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false, cwd: undefined }))

    expect(result.status).toBe('outer')
    expect(h.seams.spawnCalls[0].options.cwd).toBe(process.cwd())
  })

  it('an Electron outer lane skips restoration (non-node-lane) and still releases', async () => {
    const h = new Harness()
    const token = 'tok-acq'
    h.lock.acquireResults.push(acquired(CHECKOUT, { token }))
    h.ensure.ensureResults.push(ensureOk('electron'))
    h.seedLock(token)
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'electron', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
      expect(result.finalize.restore).toEqual({ status: 'skipped', reason: 'non-node-lane' })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.ensure.ensureCalls).toEqual(['electron'])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    expect(h.order).toEqual(['child', 'release'])
  })

  it('the prepared lease env never carries an ambient ELECTRON_RUN_AS_NODE while preserving every other base variable', async () => {
    const h = new Harness()
    h.scriptOuter()
    const base = { PATH: '/usr/bin', FOO: 'bar', [ELECTRON_RUN_AS_NODE_ENV]: '1' }
    const before = { ...base }
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false, env: base }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
    }
    // The outer child inherits the prepared lease env built from the sanitized
    // base: the ambient variable is gone while every other variable and the
    // lease survive.
    const childEnv = h.seams.spawnCalls[0].options.env
    expect(childEnv).toBeDefined()
    if (childEnv !== undefined) {
      expect(childEnv[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined()
      expect(childEnv.PATH).toBe('/usr/bin')
      expect(childEnv.FOO).toBe('bar')
      expect(leaseFromEnv(childEnv)?.owner.token).toBe('tok-acq')
    }
    // The caller env is never mutated: the ambient variable stays on the base.
    expect(base).toEqual(before)
    expect(base[ELECTRON_RUN_AS_NODE_ENV]).toBe('1')
    // The restore probe — the only place ELECTRON_RUN_AS_NODE is valid, set
    // explicitly inside effects.ts — still ran under the effects seam: the
    // sanitizer never intercepts the controlled probe path.
    expect(h.effects.electronProbeCalls).toBe(1)
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })
})

describe('runLane — target-lane-failure', () => {
  it('skips the child but still restores and releases for a local Node lane', async () => {
    const h = new Harness()
    h.scriptTargetLaneFailure()

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
      expect(result.ensure.status).toBe('rebuild-failed')
      expect(result.finalize.child).toEqual({
        ran: false,
        reason: 'target-preparation-failure',
        error: 'lane rebuild failed: node-gyp exited with code 1; EACCES: permission denied'
      })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
      expect(result.restoreDetail?.status).toBe('performed')
    }
    // The child never spawned; restoration then release still ran for local Node.
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(1)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    expect(h.order).toEqual(['restore', 'release'])
  })
})

describe('runLane — LOCK-006 exit-code precedence', () => {
  it('a failing child exit code outranks restore and release failures (statuses stay observable)', async () => {
    const h = new Harness()
    h.scriptOuter({ checkOk: false, releaseError: 'unlinkSync: EACCES' })
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 7 }

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(7)
      expect(result.finalize.child).toEqual({ ran: true, outcome: { kind: 'exited', code: 7 } })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: false })
      expect(result.finalize.release).toEqual({
        released: false,
        reason: 'error',
        error: 'unlinkSync: EACCES',
        lockPath: LOCK_PATH
      })
      // Restore-failure route made explicit: the Electron probe failed (the
      // scripted checkOk: false), and the restore rebuild then failed with the
      // exact diagnostic. No part of this relies on an unasserted rebuild
      // precondition.
      expect(result.restoreDetail).toMatchObject({
        status: 'performed',
        result: {
          status: 'rebuild-failed',
          lane: 'electron',
          check: {
            ok: false,
            failures: expect.arrayContaining([
              'Electron runtime SQL probe failed: binding does not load under Electron'
            ])
          },
          rebuild: {
            ok: false,
            failures: ['process.execPath not verified: /usr/local/bin/node.']
          }
        }
      })
    }
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('restore failure outranks release failure when the child succeeded', async () => {
    const h = new Harness()
    h.scriptOuter({ checkOk: false, releaseError: 'unlinkSync: EACCES' })
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(RESTORE_FAILURE_EXIT_CODE)
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: false })
      expect(result.finalize.release).toEqual({
        released: false,
        reason: 'error',
        error: 'unlinkSync: EACCES',
        lockPath: LOCK_PATH
      })
      // Explicit restore-failure route: the scripted probe failure is followed
      // by a rebuild that reports exactly the execPath diagnostic.
      expect(result.restoreDetail).toMatchObject({
        status: 'performed',
        result: {
          status: 'rebuild-failed',
          lane: 'electron',
          rebuild: {
            ok: false,
            failures: ['process.execPath not verified: /usr/local/bin/node.']
          }
        }
      })
    }
  })

  it('release failure is observable when the child and the restore succeeded', async () => {
    const h = new Harness()
    h.scriptOuter({ releaseError: 'unlinkSync: EACCES' })
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(RELEASE_FAILURE_EXIT_CODE)
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({
        released: false,
        reason: 'error',
        error: 'unlinkSync: EACCES',
        lockPath: LOCK_PATH
      })
    }
    // The release was attempted through the injected lockFs but failed observably.
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })
})

describe('runLane — CI policy (LOCK-003)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('an explicit ci: true overrides process.env.CI=false and skips restoration', async () => {
    vi.stubEnv('CI', 'false')
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: true }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
      expect(result.finalize.restore).toEqual({ status: 'skipped', reason: 'ci-skip' })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.order).toEqual(['child', 'release'])
  })

  it('an explicit ci: false overrides process.env.CI=true and still restores', async () => {
    vi.stubEnv('CI', 'true')
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
    }
    expect(h.effects.electronProbeCalls).toBe(1)
  })

  it('defaults CI from process.env.CI === true and skips restoration', async () => {
    vi.stubEnv('CI', 'true')
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node' }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
      expect(result.finalize.restore).toEqual({ status: 'skipped', reason: 'ci-skip' })
    }
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.order).toEqual(['child', 'release'])
  })
})

describe('runLane — default preparation seam construction (shared lockFs)', () => {
  it('default seams wire an injected lockFs into both acquisition and release', async () => {
    const h = new Harness()
    // Exercise the actual `createPreparationSeams` path: only the ensure seam
    // is injected so no real better-sqlite3 probe/rebuild runs. The resolver
    // and lease take their real defaults, and the default lock construction
    // (`createLockService`) is wired to the same injected lockFs instance that
    // runLane passes to the finalizer's release — the shared seam must reach
    // both acquisition and release.
    const seams = createPreparationSeams({
      lock: createLockService(h.lockFs),
      ensure: h.ensure
    })
    h.ensure.ensureResults.push(ensureOk('node'))
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(
      h.options({
        lane: 'node',
        ci: false,
        checkoutRoot: CHECKOUT,
        preparationSeams: seams,
        lockFs: h.lockFs
      })
    )

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
      // The default lock service performed the acquisition: the owner token
      // came from the injected lockFs (FakeLockFs.randomToken), never from a
      // scripted LockService.
      expect(result.owner.token).toBe('tok-fs')
      expect(result.lockPath).toBe(LOCK_PATH)
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    // The injected lockFs was never pre-seeded and the scripted LockService
    // was never consulted, so the shared instance alone created the lock file
    // (acquisition) and removed it exactly once (release).
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    expect(h.lockFs.files.has(LOCK_PATH)).toBe(false)
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })
})

describe('runLane — target-lane-failure with restore and release failures', () => {
  it('keeps the target preparation exit code authoritative when restore and release also fail', async () => {
    const h = new Harness()
    h.scriptTargetLaneFailure()
    h.effects.checkOk = false
    h.lockFs.removeErrors.set(LOCK_PATH, 'unlinkSync: EACCES')

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      // LOCK-006: the preserved target preparation failure outranks the later
      // restore and release failures — the exit code stays 2.
      expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
      expect(result.ensure.status).toBe('rebuild-failed')
      expect(result.finalize.child).toEqual({
        ran: false,
        reason: 'target-preparation-failure',
        error: 'lane rebuild failed: node-gyp exited with code 1; EACCES: permission denied'
      })
      // Both the restore and the release still ran, and their failures stay
      // observable on the finalize result.
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: false })
      expect(result.finalize.release).toEqual({
        released: false,
        reason: 'error',
        error: 'unlinkSync: EACCES',
        lockPath: LOCK_PATH
      })
      // Restore-failure route made explicit: the Electron probe failed, and
      // the restore rebuild failed with the exact scripted diagnostic.
      expect(result.restoreDetail).toMatchObject({
        status: 'performed',
        result: {
          status: 'rebuild-failed',
          lane: 'electron',
          check: {
            ok: false,
            failures: expect.arrayContaining([
              'Electron runtime SQL probe failed: binding does not load under Electron'
            ])
          },
          rebuild: {
            ok: false,
            failures: ['process.execPath not verified: /usr/local/bin/node.']
          }
        }
      })
    }
    // The child never spawned; the restore ran before the release, in order.
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(1)
    expect(h.lockFs.removedPaths).toEqual([]) // the release failed
    expect(h.order).toEqual(['restore', 'release'])
  })
})

describe('runLane — env defaulting (process.env base, LOCK-005)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults the env base to process.env, adds the lease only to the child copy, and never mutates process.env', async () => {
    // A stubbed empty lease is malformed (LOCK-005: never trusted), so runLane
    // with env omitted falls back to outer acquisition from process.env.
    vi.stubEnv(LEASE_ENV_NAME, '')
    const before = { ...process.env }
    delete before[LEASE_ENV_NAME]
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false, env: undefined }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
    }
    const call = h.seams.spawnCalls[0]
    expect(call).toBeDefined()
    if (call !== undefined) {
      const childEnv = call.options.env
      expect(childEnv).toBeDefined()
      expect(childEnv).not.toBe(process.env)
      if (childEnv !== undefined) {
        // Every process.env variable (except the replaced lease and the
        // deliberately-stripped ambient ELECTRON_RUN_AS_NODE launch hazard) is
        // preserved on the child copy.
        for (const [key, value] of Object.entries(before)) {
          if (key !== LEASE_ENV_NAME && key !== ELECTRON_RUN_AS_NODE_ENV && value !== undefined) {
            expect(childEnv[key]).toBe(value)
          }
        }
        // The one deliberate exception: the ambient launch hazard never
        // reaches a canonical lane child command.
        expect(childEnv[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined()
        // The lease was added only to the child copy, from the held
        // acquisition.
        const childLease = leaseFromEnv(childEnv)
        expect(childLease?.owner.token).toBe('tok-acq')
        expect(childLease?.owner.checkoutRoot).toBe(CHECKOUT)
      }
    }
    // process.env itself was never mutated: the stubbed empty lease is still
    // there — runLane never wrote the real lease into the process env.
    expect(process.env[LEASE_ENV_NAME]).toBe('')
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('defaults the env base to process.env with an ambient ELECTRON_RUN_AS_NODE stripped from the child copy', async () => {
    // The stubbed empty lease is malformed (LOCK-005: never trusted), so runLane
    // with env omitted falls back to outer acquisition from process.env, which
    // carries the ambient launch hazard.
    vi.stubEnv(LEASE_ENV_NAME, '')
    vi.stubEnv(ELECTRON_RUN_AS_NODE_ENV, '1')
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false, env: undefined }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(0)
    }
    // The child copy built from process.env never carries the ambient variable,
    // while the lease is added only to that copy.
    const childEnv = h.seams.spawnCalls[0].options.env
    expect(childEnv).toBeDefined()
    if (childEnv !== undefined) {
      expect(childEnv[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined()
      expect(childEnv[LEASE_ENV_NAME]).toBeDefined()
    }
    // The caller's process.env is never mutated: the ambient variable stays.
    expect(process.env[ELECTRON_RUN_AS_NODE_ENV]).toBe('1')
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })
})

describe('runLane — lifecycle signal guard (SIGINT/SIGTERM across the whole run)', () => {
  // The guard captures SIGINT/SIGTERM from before lane preparation until the
  // run returns, so a signal during lock acquisition, target ensure/rebuild,
  // child execution, Electron restoration, or lock release can never terminate
  // the coordinator mid-cleanup. The signals are dispatched through the
  // injected `processSeams.onSignal` registry (FakeSeams), never the real
  // process — Vitest itself is untouchable.

  /** Script an outer run whose Electron restore holds on the rebuild gate. */
  function scriptGatedRestore(h: Harness): Deferred<RebuildRunResult> {
    const gate = deferred<RebuildRunResult>()
    h.scriptOuter()
    // Fail the initial Electron check so the restore rebuilds, then pass the
    // Electron rebuild preconditions so the gated seam is actually reached.
    h.effects.checkOk = false
    h.effects.execPathExists = true
    h.effects.rebuildGate = gate
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }
    return gate
  }

  it('captures a SIGTERM arriving during the Electron restore, completes restore+release, and surfaces 128+15', async () => {
    const h = new Harness()
    const gate = scriptGatedRestore(h)

    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await gate.started // the Electron restore is now in-flight (rebuild pending)
    h.seams.dispatch('SIGTERM')
    // Pass the post-rebuild verification so the restore completes successfully.
    h.effects.checkOk = true
    gate.resolve({ ok: true, logs: [] })

    const result = await runPromise

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      // The signal is the deterministic runner outcome (128 + 15) even though
      // the child itself exited 0.
      expect(result.exitCode).toBe(143)
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGTERM', exitCode: 143 })
      // Cleanup completed despite the signal: restore performed ok, release ok.
      expect(result.finalize.child).toEqual({ ran: true, outcome: { kind: 'exited', code: 0 } })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
      expect(result.restoreDetail?.status).toBe('performed')
    }
    // failing initial check + rebuild post-check + post-rebuild verify
    expect(h.effects.electronProbeCalls).toBe(3)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    // Child, then the three Electron restore probes, then the single release.
    expect(h.order[0]).toBe('child')
    expect(h.order.slice(1, -1)).toEqual(['restore', 'restore', 'restore'])
    expect(h.order[h.order.length - 1]).toBe('release')
  })

  it('captures a SIGINT arriving during the lock release and still releases the lock exactly once', async () => {
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }
    // The release is the finalizer's last synchronous step; fire the signal
    // synchronously from inside the lock removal to model it arriving while
    // the release is executing.
    h.lockFs.signalDispatcher = (signal) => h.seams.dispatch(signal)
    h.lockFs.dispatchOnRemove = 'SIGINT'

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      expect(result.exitCode).toBe(130)
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGINT', exitCode: 130 })
      // The release completed while the signal arrived: the lock was removed.
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('unregisters every signal handler once the run returns (executor + guard)', async () => {
    const h = new Harness()
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(123)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }

    const result = await runLane(h.options({ lane: 'node', ci: false }))

    expect(result.status).toBe('outer')
    // The executor unregisters on child settlement and the guard unregisters in
    // `finally`: no handler may survive the run, and a later dispatch is a no-op.
    expect(h.seams.registeredSignals()).toEqual([])
    expect(h.seams.handlerCount()).toBe(0)
    h.seams.dispatch('SIGINT')
    if (result.status === 'outer') {
      expect(result.lifecycleSignal).toBeUndefined()
    }

    // A second run on the same seams must not accumulate handlers either.
    h.scriptOuter()
    h.seams.scriptedChild = new FakeChild(456)
    h.seams.autoOutcome = { kind: 'exited', code: 0 }
    const second = await runLane(h.options({ lane: 'node', ci: false }))
    expect(second.status).toBe('outer')
    expect(h.seams.registeredSignals()).toEqual([])
    expect(h.seams.handlerCount()).toBe(0)
  })

  it('retains the first of repeated signals and never re-runs operations', async () => {
    const h = new Harness()
    const gate = scriptGatedRestore(h)

    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await gate.started
    h.seams.dispatch('SIGINT')
    h.seams.dispatch('SIGTERM')
    h.effects.checkOk = true
    gate.resolve({ ok: true, logs: [] })

    const result = await runPromise

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      // Only the first signal is retained; the later repeat is ignored.
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGINT', exitCode: 130 })
      expect(result.exitCode).toBe(130)
    }
    // The finalizer ran exactly once: one child, one restore rebuild, one release.
    expect(h.seams.spawnCalls).toHaveLength(1)
    expect(h.effects.electronProbeCalls).toBe(3)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    // Child, then the three Electron restore probes, then the single release.
    expect(h.order[0]).toBe('child')
    expect(h.order.slice(1, -1)).toEqual(['restore', 'restore', 'restore'])
    expect(h.order[h.order.length - 1]).toBe('release')
  })

  it('keeps a failing child exit code authoritative over a captured lifecycle signal', async () => {
    const h = new Harness()
    const gate = scriptGatedRestore(h)
    // The child fails with code 7 before the signal arrives.
    h.seams.autoOutcome = { kind: 'exited', code: 7 }

    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await gate.started
    h.seams.dispatch('SIGTERM')
    gate.resolve({ ok: false, logs: [], error: 'scripted rebuild failure' })

    const result = await runPromise

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      // LOCK-006: the failing child (7) outranks the captured signal AND the
      // later restore failure; the signal stays exposed and the restore
      // diagnostic stays visible on the result.
      expect(result.exitCode).toBe(7)
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGTERM', exitCode: 143 })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: false })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('keeps a preserved target preparation failure authoritative over a captured lifecycle signal', async () => {
    const h = new Harness()
    const gate = deferred<RebuildRunResult>()
    h.scriptTargetLaneFailure()
    h.effects.checkOk = false
    h.effects.execPathExists = true
    h.effects.rebuildGate = gate

    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await gate.started
    h.seams.dispatch('SIGTERM')
    gate.resolve({ ok: false, logs: [], error: 'scripted rebuild failure' })

    const result = await runPromise

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      // The preserved target preparation failure (exit 2) outranks the signal;
      // the signal stays exposed and the restore/release diagnostics stay visible.
      expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGTERM', exitCode: 143 })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: false })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.order).toEqual(['restore', 'release'])
  })

  it('captures a signal during target ensure/rebuild: the child never spawns, restore+release still complete, signal code', async () => {
    const h = new Harness()
    const token = 'tok-acq'
    h.lock.acquireResults.push(acquired(CHECKOUT, { token }))
    h.seedLock(token)
    h.seams.scriptedChild = new FakeChild(123) // must never be spawned
    h.seams.autoOutcome = { kind: 'exited', code: 0 }
    const ensureGate = deferred<LaneEnsureResult>()
    h.ensure.ensureGate = ensureGate
    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await ensureGate.started // the target lane ensure is now in-flight
    h.seams.dispatch('SIGINT')
    h.seams.dispatch('SIGTERM') // repeated: the first signal wins
    ensureGate.resolve(ensureOk('node'))

    const result = await runPromise

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      // The requested command never spawned: the finalizer reports the
      // synthetic signaled outcome and the conventional signal exit code wins.
      expect(result.finalize.child).toEqual({
        ran: true,
        outcome: { kind: 'signaled', signal: 'SIGINT', exitCode: 130 }
      })
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGINT', exitCode: 130 })
      expect(result.exitCode).toBe(130)
      // Cleanup completed despite the latched signal: restore performed ok,
      // release ok.
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    // One acquisition, one ensure; no child spawn; restore then release in order.
    expect(h.lock.acquireCalls).toEqual([{ checkoutRoot: CHECKOUT, lane: 'node', pid: undefined }])
    expect(h.ensure.ensureCalls).toEqual(['node'])
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(1)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    expect(h.order).toEqual(['restore', 'release'])
    expect(h.seams.registeredSignals()).toEqual([])
    expect(h.seams.handlerCount()).toBe(0)
  })

  it('a signal during the child run is forwarded to the child; a signaled child stays authoritative and handlers are cleaned', async () => {
    const h = new Harness()
    h.scriptOuter()
    const child = new FakeChild(123)
    h.seams.scriptedChild = child
    const spawned = deferred<void>()
    h.seams.spawnNotify = spawned
    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await spawned.started // the child is spawned and the executor's forwarding handlers are live
    // The executor forwards the signal to the child while the lifecycle guard
    // latches it — both coexist without double-forwarding.
    h.seams.dispatch('SIGTERM')
    expect(child.killSignals).toEqual(['SIGTERM'])
    child.close(null, 'SIGTERM')

    const result = await runPromise

    expect(result.status).toBe('outer')
    if (result.status === 'outer') {
      // The signaled child is authoritative: its conventional exit code wins,
      // and the captured lifecycle signal stays exposed.
      expect(result.finalize.child).toEqual({
        ran: true,
        outcome: { kind: 'signaled', signal: 'SIGTERM', exitCode: 143 }
      })
      expect(result.exitCode).toBe(143)
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGTERM', exitCode: 143 })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.order).toEqual(['child', 'restore', 'release'])
    // The executor's forwarding handlers and the lifecycle guard handlers are
    // both unregistered once the run completes.
    expect(h.seams.registeredSignals()).toEqual([])
    expect(h.seams.handlerCount()).toBe(0)
  })

  it('nested: a child that exits 0 after a captured signal yields the conventional signal exit code', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-nested', lane: 'node' }))
    const child = new FakeChild(123)
    h.seams.scriptedChild = child
    const spawned = deferred<void>()
    h.seams.spawnNotify = spawned
    const runPromise = runLane(h.options({ env }))
    await spawned.started
    // The lifecycle guard coexists with the executor's forwarding handlers: the
    // child receives the forwarded signal, then settles with exit code 0.
    h.seams.dispatch('SIGTERM')
    expect(child.killSignals).toEqual(['SIGTERM'])
    child.close(0, null)

    const result = await runPromise

    expect(result.status).toBe('nested')
    if (result.status === 'nested') {
      // The child outcome stays verbatim; the captured signal is exposed and
      // its conventional exit code wins over the clean child exit.
      expect(result.child).toEqual({ kind: 'exited', code: 0 })
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGTERM', exitCode: 143 })
      expect(result.exitCode).toBe(143)
    }
    // Still a pure nested pass-through: no lock, ensure, restore, or release.
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(0)
    expect(h.lockFs.removedPaths).toEqual([])
    expect(h.order).toEqual(['child'])
    // Both the executor's forwarding handlers and the lifecycle guard handlers
    // are cleaned once the run completes.
    expect(h.seams.registeredSignals()).toEqual([])
    expect(h.seams.handlerCount()).toBe(0)
  })

  it('a signal captured during a failing ensure keeps the preserved target preparation failure authoritative', async () => {
    const h = new Harness()
    const token = 'tok-acq'
    h.lock.acquireResults.push(acquired(CHECKOUT, { token }))
    h.seedLock(token)
    const ensureGate = deferred<LaneEnsureResult>()
    h.ensure.ensureGate = ensureGate
    const runPromise = runLane(h.options({ lane: 'node', ci: false }))
    await ensureGate.started
    h.seams.dispatch('SIGINT')
    ensureGate.resolve(ensureRebuildFailed('node'))

    const result = await runPromise

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      // The preserved target preparation failure (exit 2) outranks the signal
      // captured during the ensure; the signal stays exposed and restore/release
      // still completed.
      expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
      expect(result.lifecycleSignal).toEqual({ signal: 'SIGINT', exitCode: 130 })
      expect(result.finalize.child).toEqual({
        ran: false,
        reason: 'target-preparation-failure',
        error: 'lane rebuild failed: node-gyp exited with code 1; EACCES: permission denied'
      })
      expect(result.finalize.restore).toEqual({ status: 'performed', ok: true })
      expect(result.finalize.release).toEqual({ released: true, lockPath: LOCK_PATH })
    }
    expect(h.seams.spawnCalls).toEqual([])
    expect(h.effects.electronProbeCalls).toBe(1)
    expect(h.lockFs.removedPaths).toEqual([LOCK_PATH])
    expect(h.order).toEqual(['restore', 'release'])
  })
})
