import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  conventionalExitCode,
  createProcessExecutorSeams,
  executeProcess,
  FALLBACK_SIGNAL_NUMBERS,
  type ProcessExecutorSeams,
  type SpawnedChild
} from '../executor'

// ---------------------------------------------------------------------------
// Deterministic fake seams: a scripted child EventEmitter plus an in-memory
// signal registry whose unsubscribe functions mirror `process.off` semantics
// (they actually remove the registered handler).
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter implements SpawnedChild {
  pid: number | undefined
  killedSignals: NodeJS.Signals[] = []
  killedCount = 0

  constructor(pid?: number) {
    super()
    this.pid = pid
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedCount += 1
    if (signal !== undefined) {
      this.killedSignals.push(signal)
    }
    return true
  }

  /** Emit a scripted 'close' with an exit code and/or termination signal. */
  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal)
  }

  /** Emit a scripted 'error' (spawn failure). */
  fail(error: Error): void {
    this.emit('error', error)
  }
}

interface SignalEntry {
  signal: NodeJS.Signals
  handler: () => void
}

class FakeSeams implements ProcessExecutorSeams {
  spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  registered: SignalEntry[] = []
  unregistered: SignalEntry[] = []
  scriptedChild: FakeChild | null = null
  /** When set, onSignal throws this error for the matching signal (registration failure). */
  signalRegistrationError: { signal: NodeJS.Signals; error: Error } | undefined

  spawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedChild {
    this.spawnCalls.push({ command, args, options })
    const child = this.scriptedChild
    if (child === null) {
      throw new Error('FakeSeams: no scripted child')
    }
    this.scriptedChild = null
    return child
  }

  onSignal(signal: NodeJS.Signals, handler: () => void): () => void {
    if (this.signalRegistrationError !== undefined && this.signalRegistrationError.signal === signal) {
      throw this.signalRegistrationError.error
    }
    const entry: SignalEntry = { signal, handler }
    this.registered.push(entry)
    return () => {
      const index = this.registered.indexOf(entry)
      if (index >= 0) {
        this.registered.splice(index, 1)
        this.unregistered.push(entry)
      }
    }
  }

  /** Deliver a parent signal to every currently registered handler. */
  deliverSignal(signal: NodeJS.Signals): void {
    for (const entry of [...this.registered]) {
      if (entry.signal === signal) {
        entry.handler()
      }
    }
  }
}

const errnoError = (message: string, code: string): NodeJS.ErrnoException => {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('executeProcess — exit outcomes', () => {
  it('resolves exited(0) on a clean zero exit', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(123)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/bin/true', args: [] })
    child.close(0, null)
    await expect(promise).resolves.toEqual({ kind: 'exited', code: 0 })
  })

  it('preserves a nonzero exit code', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(123)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/bin/false', args: [] })
    child.close(7, null)
    await expect(promise).resolves.toEqual({ kind: 'exited', code: 7 })
  })

  it('resolves signaled with the deterministic conventional exit code', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(123)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/bin/sleep', args: [] })
    child.close(null, 'SIGTERM')
    await expect(promise).resolves.toEqual({ kind: 'signaled', signal: 'SIGTERM', exitCode: 143 })
  })

  it('maps conventional exit codes deterministically (128 + signal number)', () => {
    expect(conventionalExitCode('SIGINT')).toBe(130)
    expect(conventionalExitCode('SIGTERM')).toBe(143)
    expect(conventionalExitCode('SIGKILL')).toBe(137)
    // Unknown signal names fall back to 1 so the mapping stays total.
    expect(conventionalExitCode('SIGBOGUS' as NodeJS.Signals)).toBe(1)
  })

  it('falls back to stable signal numbers when the platform table lacks a known signal', () => {
    // SIGSTKFLT (16) is absent from darwin's os.constants.signals and from most
    // minimal tables; the stable fallback keeps the conventional mapping.
    expect(conventionalExitCode('SIGSTKFLT')).toBe(144)
    expect(conventionalExitCode('SIGPWR')).toBe(158)
    // The fallback table itself carries the conventional Linux numbers.
    expect(FALLBACK_SIGNAL_NUMBERS.SIGINT).toBe(2)
    expect(FALLBACK_SIGNAL_NUMBERS.SIGTERM).toBe(15)
    expect(FALLBACK_SIGNAL_NUMBERS.SIGKILL).toBe(9)
    // The fallback is used exactly where the platform table lacks the signal;
    // every such entry maps to 128 + number (mapping stays total).
    for (const [name, number] of Object.entries(FALLBACK_SIGNAL_NUMBERS)) {
      const platformNumber = (os.constants.signals as Record<string, number | undefined>)[name]
      if (platformNumber === undefined) {
        expect(conventionalExitCode(name as NodeJS.Signals)).toBe(128 + number)
      }
    }
  })
})

describe('executeProcess — spawn errors', () => {
  it('resolves spawn-error from an async child error event (ENOENT-style)', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild() // no pid: the spawn never produced a process
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/no/such/executable', args: [] })
    child.fail(errnoError('spawn /no/such/executable ENOENT', 'ENOENT'))
    await expect(promise).resolves.toEqual({
      kind: 'spawn-error',
      message: 'spawn /no/such/executable ENOENT',
      code: 'ENOENT'
    })
  })

  it('resolves spawn-error from a synchronous spawn throw', async () => {
    const seams = new FakeSeams() // scriptedChild stays null -> spawn throws
    await expect(executeProcess(seams, { command: '/bin/x', args: [] })).resolves.toMatchObject({
      kind: 'spawn-error',
      message: 'FakeSeams: no scripted child'
    })
  })
})

describe('executeProcess — argv/cwd/env/stdio forwarding', () => {
  it('passes command, argv, cwd, env and stdio to the spawn seam', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(42)
    seams.scriptedChild = child
    const env = { ...process.env, NATIVE_ABI_TEST: 'inherited-value' }
    const promise = executeProcess(seams, {
      command: '/opt/tool/bin/runner',
      args: ['--lane', 'node', '--flag'],
      cwd: '/custom/checkout',
      env,
      stdio: 'inherit'
    })
    child.close(0, null)
    await expect(promise).resolves.toEqual({ kind: 'exited', code: 0 })
    expect(seams.spawnCalls).toHaveLength(1)
    expect(seams.spawnCalls[0].command).toBe('/opt/tool/bin/runner')
    expect(seams.spawnCalls[0].args).toEqual(['--lane', 'node', '--flag'])
    expect(seams.spawnCalls[0].options.cwd).toBe('/custom/checkout')
    expect(seams.spawnCalls[0].options.env).toEqual(env)
    expect(seams.spawnCalls[0].options.stdio).toBe('inherit')
  })

  it('defaults cwd/env/stdio to process.cwd(), process.env and inherit', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(42)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: ['--version'] })
    child.close(0, null)
    await promise
    const options = seams.spawnCalls[0].options
    expect(options.cwd).toBe(process.cwd())
    expect(options.env).toBe(process.env)
    expect(options.stdio).toBe('inherit')
  })

  it('never enables the shell (no shell string parsing)', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(42)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: ['-e', '1'] })
    child.close(0, null)
    await promise
    expect(seams.spawnCalls[0].options.shell).toBeUndefined()
  })
})

describe('executeProcess — parent signal forwarding', () => {
  it('forwards SIGINT and SIGTERM to the running child (and never SIGKILL)', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: ['--version'] })

    seams.deliverSignal('SIGINT')
    seams.deliverSignal('SIGTERM')
    seams.deliverSignal('SIGKILL') // uncatchable on the parent: never forwarded
    expect(child.killedSignals).toEqual(['SIGINT', 'SIGTERM'])
    expect(child.killedCount).toBe(2)

    child.close(0, null)
    await expect(promise).resolves.toEqual({ kind: 'exited', code: 0 })
  })

  it('forwards only the configured signal list', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [], forwardedSignals: ['SIGTERM'] })
    seams.deliverSignal('SIGINT')
    seams.deliverSignal('SIGTERM')
    expect(child.killedSignals).toEqual(['SIGTERM'])
    child.close(0, null)
    await promise
  })

  it('forwards a parent SIGTERM and yields signaled/SIGTERM/143 with full cleanup', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    expect(seams.registered).toHaveLength(2)
    seams.deliverSignal('SIGTERM')
    expect(child.killedSignals).toEqual(['SIGTERM'])
    child.close(null, 'SIGTERM')
    await expect(promise).resolves.toEqual({ kind: 'signaled', signal: 'SIGTERM', exitCode: 143 })
    // Every forward handler is unregistered once the outcome settles.
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(2)
  })

  it('does not forward after settlement (stale handler guard)', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    child.close(0, null)
    await expect(promise).resolves.toEqual({ kind: 'exited', code: 0 })

    // The registry is empty (unsubscribed); a stale in-flight handler must
    // still not reach the child because the executor settled.
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(2)
    for (const entry of seams.unregistered) {
      entry.handler()
    }
    seams.deliverSignal('SIGINT')
    seams.deliverSignal('SIGTERM')
    expect(child.killedSignals).toEqual([])
    expect(child.killedCount).toBe(0)
  })

  it('registers no forward handler when the child never spawned (pid undefined)', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild()
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/no/such', args: [] })
    expect(seams.registered).toHaveLength(0)
    child.fail(errnoError('spawn /no/such ENOENT', 'ENOENT'))
    await expect(promise).resolves.toMatchObject({ kind: 'spawn-error' })
  })
})

describe('executeProcess — signal listener cleanup on every path', () => {
  it('unregisters all forward handlers on a clean exit', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    expect(seams.registered).toHaveLength(2)
    child.close(0, null)
    await promise
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(2)
  })

  it('unregisters all forward handlers on a signaled exit', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    expect(seams.registered).toHaveLength(2)
    child.close(null, 'SIGKILL')
    await expect(promise).resolves.toEqual({ kind: 'signaled', signal: 'SIGKILL', exitCode: 137 })
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(2)
  })

  it('unregisters all forward handlers on a spawn error', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    expect(seams.registered).toHaveLength(2)
    child.fail(new Error('boom'))
    await expect(promise).resolves.toMatchObject({ kind: 'spawn-error' })
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(2)
  })

  it('resolves a spawn-error and unregisters prior handlers when a signal cannot be registered', async () => {
    const seams = new FakeSeams()
    // SIGINT registers first; SIGTERM then throws mid-loop.
    seams.signalRegistrationError = {
      signal: 'SIGTERM',
      error: errnoError('unable to handle signal SIGTERM', 'ERR_UNKNOWN_SIGNAL')
    }
    const child = new FakeChild(99)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    // The already-registered SIGINT handler must have been unregistered — no
    // leaked parent listener.
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(1)
    // The promise resolves with the same discriminated outcome as a spawn
    // failure; it never rejects for an unregistrable signal.
    const outcome = await promise
    expect(outcome).toEqual({
      kind: 'spawn-error',
      message: expect.stringContaining('unable to handle signal SIGTERM'),
      code: 'ERR_UNKNOWN_SIGNAL'
    })
    // The child stays observed: late error/close events after settlement are
    // no-ops (single-shot guard), not an unhandled 'error' crash.
    child.fail(new Error('late error'))
    child.close(null, 'SIGTERM')
  })
})

describe('executeProcess — error/close race', () => {
  it('settles once with the spawn error when error precedes close', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild()
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/no/such', args: [] })
    child.fail(errnoError('spawn /no/such ENOENT', 'ENOENT'))
    // Real Node emits 'close' with null/null after a failed spawn.
    child.close(null, null)
    await expect(promise).resolves.toEqual({ kind: 'spawn-error', message: 'spawn /no/such ENOENT', code: 'ENOENT' })
  })

  it('yields one spawn-error plus cleanup when a pid-set child errors then closes null/null', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(5) // pid present: forward handlers ARE registered
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: '/no/such', args: [] })
    expect(seams.registered).toHaveLength(2)
    child.fail(errnoError('spawn /no/such ENOENT', 'ENOENT'))
    // The documented spawn-failure tail must not override the error outcome.
    child.close(null, null)
    await expect(promise).resolves.toEqual({ kind: 'spawn-error', message: 'spawn /no/such ENOENT', code: 'ENOENT' })
    expect(seams.registered).toHaveLength(0)
    expect(seams.unregistered).toHaveLength(2)
  })

  it('settles once with the exit outcome when close precedes error', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(5)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    child.close(0, null)
    child.fail(new Error('late error'))
    await expect(promise).resolves.toEqual({ kind: 'exited', code: 0 })
  })

  it('settles once with the signal outcome when close precedes error', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(5)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    child.close(null, 'SIGINT')
    child.fail(new Error('late error'))
    await expect(promise).resolves.toEqual({ kind: 'signaled', signal: 'SIGINT', exitCode: 130 })
  })

  it('maps a close with neither code nor signal to a defensive spawn error', async () => {
    const seams = new FakeSeams()
    const child = new FakeChild(5)
    seams.scriptedChild = child
    const promise = executeProcess(seams, { command: 'node', args: [] })
    child.close(null, null)
    await expect(promise).resolves.toEqual({
      kind: 'spawn-error',
      message: 'child closed without an exit code or termination signal'
    })
  })
})

// ---------------------------------------------------------------------------
// Bounded real-wiring smoke tests: `createProcessExecutorSeams()` against real
// `node` children (no native binding involved). Signal forwarding is verified
// only through fakes above — delivering SIGINT/SIGTERM to this test process
// could terminate the Vitest run itself.
// ---------------------------------------------------------------------------

describe('executeProcess — real wiring smoke (bounded real subprocess)', () => {
  const seams = createProcessExecutorSeams()

  it('runs a real child to exit 0', async () => {
    const outcome = await executeProcess(seams, { command: process.execPath, args: ['-e', 'process.exit(0)'] })
    expect(outcome).toEqual({ kind: 'exited', code: 0 })
  }, 15_000)

  it('preserves a real nonzero exit code', async () => {
    const outcome = await executeProcess(seams, { command: process.execPath, args: ['-e', 'process.exit(7)'] })
    expect(outcome).toEqual({ kind: 'exited', code: 7 })
  }, 15_000)

  it.skipIf(process.platform === 'win32')(
    'reports a real signal-terminated child with the conventional exit code',
    async () => {
      const outcome = await executeProcess(seams, {
        command: process.execPath,
        args: ['-e', "process.kill(process.pid, 'SIGTERM')"]
      })
      expect(outcome).toEqual({ kind: 'signaled', signal: 'SIGTERM', exitCode: 143 })
    },
    15_000
  )

  it('inherits the supplied cwd and env for a real child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-exec-'))
    try {
      // macOS TMPDIR (`/var/folders/...`) is a symlink; getcwd() in the child
      // returns the resolved realpath, so compare against that.
      const expectedCwd = fs.realpathSync(dir)
      const script = `if (process.cwd() !== ${JSON.stringify(expectedCwd)}) process.exit(9); if (process.env.EXEC_SEAM !== 'yes') process.exit(10)`
      const outcome = await executeProcess(seams, {
        command: process.execPath,
        args: ['-e', script],
        cwd: dir,
        env: { ...process.env, EXEC_SEAM: 'yes' }
      })
      expect(outcome).toEqual({ kind: 'exited', code: 0 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
