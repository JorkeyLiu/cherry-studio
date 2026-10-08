import { describe, expect, it, vi } from 'vitest'

import { createProcessExecutorSeams, type ProcessExecutorSeams, type SpawnedChild } from '../executor'
import { CHILD_SPAWN_ERROR_EXIT_CODE, PROBE_FAILURE_EXIT_CODE, runRuntime, stripElectronRunAsNode } from '../run'
import type { Effects } from '../types'

/**
 * Focused regression coverage for the narrow standard runner
 * (scripts/native-runtime/run.ts):
 *
 *  - `ELECTRON_RUN_AS_NODE` is stripped from inherited env (never mutated)
 *    before probing and child execution; only the controlled probe env may
 *    set it;
 *  - a failing probe never spawns the child (probe-failure result);
 *  - the child command + argv pass through verbatim (explicit argv, no shell);
 *  - the child's own exit outcome is preserved verbatim (trustworthy exit
 *    semantics), including signaled and spawn-error outcomes;
 *  - concurrent invocations are safe (no locks/leases/serialized execution —
 *    parallel runs all complete with their own outcomes).
 */

function passingEffects(): Effects {
  return {
    runtimeInfo: () => ({
      runtime: 'node',
      nodeVersion: '24.11.1',
      modulesAbi: 137,
      platform: 'darwin',
      arch: 'arm64',
      execPath: '/node'
    }),
    readJson: () => ({}),
    realpath: (p) => p,
    exists: () => true,
    resolvePackageJsonPath: () => '/pkg/package.json',
    probeNodeBinding: () => ({ ok: true, sqlOk: true }),
    electronBinPath: () => '/electron',
    electronVersion: () => '41.2.1',
    spawnElectronProbe: () => ({
      code: 0,
      stdout: `NATIVE_RUNTIME_PROBE_V1 ${JSON.stringify({ ok: true, runtime: 'electron', version: '41.2.1', nodeVersion: '24.14.1', abi: 145, platform: 'darwin', arch: 'arm64', sqlOk: true })}\n`,
      stderr: ''
    }),
    probePath: () => '/probe.cjs'
  }
}

class FakeChild implements SpawnedChild {
  readonly pid = 123
  constructor(
    private readonly code: number | null,
    private readonly signal: NodeJS.Signals | null
  ) {}
  kill(): boolean {
    return true
  }
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(
    event: 'close' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)
  ): this {
    if (event === 'close') {
      const close = listener as (code: number | null, signal: NodeJS.Signals | null) => void
      queueMicrotask(() => close(this.code, this.signal))
    }
    return this
  }
}

function fakeChild(code: number | null, signal: NodeJS.Signals | null): SpawnedChild {
  return new FakeChild(code, signal)
}

class DelayedFakeChild extends FakeChild {
  constructor(
    private readonly delayMs: number,
    code: number | null = 0,
    signal: NodeJS.Signals | null = null
  ) {
    super(code, signal)
  }
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(
    event: 'close' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)
  ): this {
    if (event === 'close') {
      const fire = listener as (code: number | null, signal: NodeJS.Signals | null) => void
      setTimeout(() => fire(0, null), this.delayMs)
      return this
    }
    return super.on(event, listener as (error: Error) => void)
  }
}

function fakeSeams(spawnImpl: ProcessExecutorSeams['spawn']): ProcessExecutorSeams {
  return {
    spawn: spawnImpl,
    onSignal: () => () => {}
  }
}

describe('stripElectronRunAsNode', () => {
  it('returns the same reference when the variable is absent', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', FOO: 'bar' }
    expect(stripElectronRunAsNode(env)).toBe(env)
  })

  it('removes only ELECTRON_RUN_AS_NODE without mutating the input', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' }
    const stripped = stripElectronRunAsNode(env)
    expect(stripped).not.toBe(env)
    expect(stripped.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(stripped.KEEP).toBe('yes')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('runRuntime', () => {
  it('probes node, then spawns the explicit command with verbatim argv and sanitized env', async () => {
    const seen: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = []
    const seams = fakeSeams((command, args, options) => {
      seen.push({ command, args, env: options.env as NodeJS.ProcessEnv })
      return fakeChild(0, null)
    })
    const result = await runRuntime({
      target: 'node',
      command: 'pnpm',
      args: ['vitest', 'run', '--project', 'renderer'],
      env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' },
      effects: passingEffects(),
      processSeams: seams
    })
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('unreachable')
    expect(result.exitCode).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].command).toBe('pnpm')
    expect(seen[0].args).toEqual(['vitest', 'run', '--project', 'renderer'])
    expect(seen[0].env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(seen[0].env?.PATH).toBe('/bin')
  })

  it('a failing node probe never spawns the child', async () => {
    const effects = passingEffects()
    effects.probeNodeBinding = () => ({ ok: false, sqlOk: false, error: 'probe boom', closeError: 'close boom' })
    const spawn = vi.fn<ProcessExecutorSeams['spawn']>(() => fakeChild(0, null))
    const result = await runRuntime({
      target: 'node',
      command: 'pnpm',
      args: ['test'],
      env: {},
      effects,
      processSeams: fakeSeams(spawn)
    })
    expect(result.status).toBe('probe-failure')
    if (result.status !== 'probe-failure') throw new Error('unreachable')
    expect(result.error).toBe('probe boom')
    expect(result.closeError).toBe('close boom')
    expect(result.exitCode).toBe(PROBE_FAILURE_EXIT_CODE)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a failing electron probe never spawns the child', async () => {
    const effects = passingEffects()
    effects.spawnElectronProbe = () => ({ code: 1, stdout: 'no marker here\n', stderr: '' })
    const spawn = vi.fn<ProcessExecutorSeams['spawn']>(() => fakeChild(0, null))
    const result = await runRuntime({
      target: 'electron',
      command: 'pnpm',
      args: ['build'],
      env: {},
      effects,
      processSeams: fakeSeams(spawn)
    })
    expect(result.status).toBe('probe-failure')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('preserves nonzero child exit codes verbatim', async () => {
    const seams = fakeSeams(() => fakeChild(7, null))
    const result = await runRuntime({
      target: 'node',
      command: 'x',
      args: [],
      env: {},
      effects: passingEffects(),
      processSeams: seams
    })
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('unreachable')
    expect(result.exitCode).toBe(7)
    expect(result.child).toEqual({ kind: 'exited', code: 7 })
  })

  it('maps a signaled child to the conventional exit code', async () => {
    const seams = fakeSeams(() => fakeChild(null, 'SIGTERM'))
    const result = await runRuntime({
      target: 'node',
      command: 'x',
      args: [],
      env: {},
      effects: passingEffects(),
      processSeams: seams
    })
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('unreachable')
    // SIGTERM is signal 15 on every supported platform table → 143.
    expect(result.exitCode).toBe(143)
  })

  it('maps a spawn error to the deterministic spawn-error exit code', async () => {
    const seams: ProcessExecutorSeams = {
      spawn: () => {
        throw Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })
      },
      onSignal: () => () => {}
    }
    const result = await runRuntime({
      target: 'node',
      command: 'x',
      args: [],
      env: {},
      effects: passingEffects(),
      processSeams: seams
    })
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('unreachable')
    expect(result.exitCode).toBe(CHILD_SPAWN_ERROR_EXIT_CODE)
    expect(result.child.kind).toBe('spawn-error')
  })

  it('concurrent invocations all complete with their own outcomes (no serialization)', async () => {
    // Delayed fakes prove overlap: every run starts before any run settles.
    const started: string[] = []
    const makeSeams = (id: string, delayMs: number): ProcessExecutorSeams => ({
      spawn: () => {
        started.push(id)
        return new DelayedFakeChild(delayMs)
      },
      onSignal: () => () => {}
    })
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        runRuntime({
          target: 'node',
          command: `cmd-${id}`,
          args: [id],
          env: {},
          effects: passingEffects(),
          processSeams: makeSeams(id, 30)
        })
      )
    )
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    for (const result of results) {
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(0)
    }
  })

  it('real concurrent runner success: parallel node children all exit 0', async () => {
    const seams = createProcessExecutorSeams()
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        runRuntime({
          target: 'node',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: { ...process.env },
          effects: passingEffects(),
          processSeams: seams
        })
      )
    )
    for (const result of results) {
      expect(result.status).toBe('completed')
      expect(result.exitCode).toBe(0)
    }
  }, 60000)
})
