import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { ProcessOutcome } from '../../native-abi/executor'
import {
  buildChildArgv,
  CHILD_COMMAND,
  computeNormalShardCount,
  isCI,
  partitionNormalFiles,
  planRendererRun,
  SHIKI_FILE,
  splitRendererFiles
} from '../rendererLanes'
import { parseExtraArgs, type RendererRunSeams, runRendererWithSeams } from '../runRenderer'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
}

function syntheticFiles(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `src/renderer/src/a${String(index).padStart(3, '0')}.test.ts`
  ).sort()
}

function withShiki(files: string[]): string[] {
  return [...files, SHIKI_FILE].sort()
}

function makeSeams(overrides: Partial<RendererRunSeams> & { allFiles: string[] }): RendererRunSeams {
  const stdout: string[] = []
  const stderr: string[] = []
  const executed: Array<{ command: string; args: readonly string[] }> = []
  const seams: RendererRunSeams = {
    enumerate: () => overrides.allFiles,
    cpuCount: overrides.cpuCount ?? (() => 8),
    env: overrides.env ?? {},
    extraArgs: overrides.extraArgs ?? [],
    execute:
      overrides.execute ??
      (async (command, args) => {
        executed.push({ command, args })
        return { kind: 'exited', code: 0 }
      }),
    stdout: overrides.stdout ?? ((text: string) => stdout.push(text)),
    stderr: overrides.stderr ?? ((text: string) => stderr.push(text)),
    now: overrides.now ?? (() => 0)
  }
  ;(seams as unknown as { executed: unknown }).executed = executed
  ;(seams as unknown as { stdoutLines: unknown }).stdoutLines = stdout
  ;(seams as unknown as { stderrLines: unknown }).stderrLines = stderr
  return seams
}

describe('renderer planner union and determinism', () => {
  it('covers the full union with no gaps and no overlap', () => {
    const allFiles = withShiki(syntheticFiles(10))
    const plan = planRendererRun({ allFiles, cpuCount: 8, env: {} })
    expect(plan.mode).toBe('local')
    const union = plan.invocations.flatMap((invocation) => invocation.files).sort()
    expect(union).toEqual([...allFiles].sort())
    expect(new Set(union).size).toBe(allFiles.length)
  })

  it('is deterministic across repeated plans', () => {
    const allFiles = withShiki(syntheticFiles(25))
    const first = planRendererRun({ allFiles, cpuCount: 8, env: {} })
    const second = planRendererRun({ allFiles: [...allFiles].reverse(), cpuCount: 8, env: {} })
    expect(second).toEqual(first)
  })

  it('keeps partitions count-balanced (sizes differ by at most one)', () => {
    const normal = syntheticFiles(10)
    const shards = partitionNormalFiles(normal, 3)
    expect(shards).toHaveLength(3)
    const sizes = shards.map((shard) => shard.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    expect(shards.flat().sort()).toEqual(normal)
  })
})

describe('shiki dedicated isolation', () => {
  it('runs the Shiki file alone in its own invocation', () => {
    const allFiles = withShiki(syntheticFiles(9))
    const plan = planRendererRun({ allFiles, cpuCount: 8, env: {} })
    const shikiInvocations = plan.invocations.filter((invocation) => invocation.kind === 'shiki')
    expect(shikiInvocations).toHaveLength(1)
    expect(shikiInvocations[0].files).toEqual([SHIKI_FILE])
    for (const invocation of plan.invocations) {
      if (invocation.kind === 'normal') {
        expect(invocation.files).not.toContain(SHIKI_FILE)
      }
    }
  })

  it('fails closed when the required Shiki file is absent', () => {
    expect(() => splitRendererFiles(syntheticFiles(5))).toThrow(SHIKI_FILE)
  })

  it('fails closed on empty enumeration', () => {
    expect(() => splitRendererFiles([])).toThrow()
  })
})

describe('shard count bounds', () => {
  it('yields 3 normal shards on the current 8-core host plus one Shiki invocation', () => {
    expect(computeNormalShardCount(8, 491)).toBe(3)
    const plan = planRendererRun({ allFiles: withShiki(syntheticFiles(491)), cpuCount: 8, env: {} })
    expect(plan.invocations.filter((invocation) => invocation.kind === 'normal')).toHaveLength(3)
    expect(plan.invocations).toHaveLength(4)
  })

  it('falls back to a single bounded normal shard on low CPU', () => {
    expect(computeNormalShardCount(1, 100)).toBe(1)
    expect(computeNormalShardCount(2, 100)).toBe(1)
    expect(computeNormalShardCount(4, 100)).toBe(1)
    expect(computeNormalShardCount(6, 100)).toBe(2)
  })

  it('never creates empty shards when files are fewer than the bound', () => {
    expect(computeNormalShardCount(8, 1)).toBe(1)
    expect(computeNormalShardCount(8, 2)).toBe(2)
    const plan = planRendererRun({ allFiles: withShiki(syntheticFiles(1)), cpuCount: 8, env: {} })
    expect(plan.invocations.filter((invocation) => invocation.kind === 'normal')).toHaveLength(1)
  })

  it('caps normal shards at 3 even on many-core hosts', () => {
    expect(computeNormalShardCount(32, 500)).toBe(3)
    expect(computeNormalShardCount(64, 500)).toBe(3)
  })
})

describe('CI mode preserves the single full invocation', () => {
  it('treats CI truthy values as CI and falsy spellings as local', () => {
    expect(isCI({ CI: 'true' })).toBe(true)
    expect(isCI({ CI: '1' })).toBe(true)
    expect(isCI({ CI: 'TRUE' })).toBe(true)
    expect(isCI({})).toBe(false)
    expect(isCI({ CI: '' })).toBe(false)
    expect(isCI({ CI: '0' })).toBe(false)
    expect(isCI({ CI: 'false' })).toBe(false)
    expect(isCI({ CI: 'FALSE' })).toBe(false)
  })

  it('plans exactly one full invocation with no explicit file partition', () => {
    const allFiles = withShiki(syntheticFiles(20))
    const plan = planRendererRun({ allFiles, cpuCount: 8, env: { CI: 'true' } })
    expect(plan.mode).toBe('ci')
    expect(plan.invocations).toHaveLength(1)
    expect(plan.invocations[0].kind).toBe('full')
    expect(plan.invocations[0].files).toEqual([])
  })

  it('builds the exact existing full command with no files', () => {
    const argv = buildChildArgv({ kind: 'full', label: 'full', files: [] })
    expect(argv).toEqual(['native:run', 'node', '--', 'vitest', 'run', '--project', 'renderer'])
  })
})

describe('canonical argv and no shell', () => {
  it('uses pnpm with the same-lane lease prefix and explicit files', () => {
    const argv = buildChildArgv({ kind: 'normal', label: 'normal-1/3', files: ['a.test.ts', 'b.test.ts'] })
    expect(CHILD_COMMAND).toBe('pnpm')
    expect(argv.slice(0, 7)).toEqual(['native:run', 'node', '--', 'vitest', 'run', '--project', 'renderer'])
    expect(argv.slice(7)).toEqual(['a.test.ts', 'b.test.ts'])
  })

  it('forwards extra args before files and never uses a native --shard flag', () => {
    const argv = buildChildArgv({ kind: 'normal', label: 'normal-1/3', files: ['a.test.ts'] }, ['--update'])
    expect(argv).toEqual([
      'native:run',
      'node',
      '--',
      'vitest',
      'run',
      '--project',
      'renderer',
      '--update',
      'a.test.ts'
    ])
    expect(argv).not.toContain('--shard')
  })

  it('invokes every child as argv through pnpm with no shell metacharacters', async () => {
    const allFiles = withShiki(syntheticFiles(6))
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const seams = makeSeams({
      allFiles,
      execute: async (command, args) => {
        calls.push({ command, args })
        return { kind: 'exited', code: 0 }
      }
    })
    const code = await runRendererWithSeams(seams)
    expect(code).toBe(0)
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.command).toBe('pnpm')
      expect(call.args.slice(0, 7)).toEqual(['native:run', 'node', '--', 'vitest', 'run', '--project', 'renderer'])
      const joined = call.args.join(' ')
      expect(joined).not.toContain('&&')
      expect(joined).not.toContain('||')
      expect(joined).not.toContain(';')
    }
  })

  it('reuses explicit argv (no shell:true) in the real runner source', () => {
    const source = readRepoFile('scripts/vitest-lanes/runRenderer.ts')
    expect(source).not.toContain('shell:true')
    expect(source).not.toContain('shell: true')
    expect(source).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(source).toContain('executeProcess')
    const lanesSource = readRepoFile('scripts/vitest-lanes/rendererLanes.ts')
    expect(lanesSource).not.toContain('--shard')
  })
})

describe('concurrent starts and failure propagation', () => {
  it('starts all invocations before awaiting completion (bounded concurrent starts)', async () => {
    const allFiles = withShiki(syntheticFiles(12))
    const started: string[][] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seams = makeSeams({
      allFiles,
      execute: async (_command, args) => {
        started.push([...args])
        await gate
        return { kind: 'exited', code: 0 }
      }
    })
    const plan = planRendererRun({ allFiles, cpuCount: 8, env: {} })
    const pending = runRendererWithSeams(seams)
    await Promise.resolve()
    await Promise.resolve()
    // Every child must have started while the gate is still closed.
    expect(started.length).toBe(plan.invocations.length)
    release()
    await expect(pending).resolves.toBe(0)
  })

  it('fails on nonzero exit and waits for all siblings', async () => {
    const allFiles = withShiki(syntheticFiles(6))
    const plan = planRendererRun({ allFiles, cpuCount: 8, env: {} })
    const finished: string[] = []
    const seams = makeSeams({
      allFiles,
      execute: async (_command, args) => {
        const files = args.slice(7).join(',')
        finished.push(files)
        if (finished.length === 1) {
          return { kind: 'exited', code: 1 } satisfies ProcessOutcome
        }
        return { kind: 'exited', code: 0 } satisfies ProcessOutcome
      }
    })
    const code = await runRendererWithSeams(seams)
    expect(code).toBe(1)
    expect(finished.length).toBe(plan.invocations.length)
  })

  it('fails on signal and on spawn error', async () => {
    const allFiles = withShiki(syntheticFiles(4))
    const signalSeams = makeSeams({
      allFiles,
      execute: async () => ({ kind: 'signaled', signal: 'SIGTERM', exitCode: 143 }) satisfies ProcessOutcome
    })
    await expect(runRendererWithSeams(signalSeams)).resolves.toBe(1)

    const spawnSeams = makeSeams({
      allFiles,
      execute: async () => ({ kind: 'spawn-error', message: 'ENOENT' }) satisfies ProcessOutcome
    })
    await expect(runRendererWithSeams(spawnSeams)).resolves.toBe(1)
  })

  it('fails on orchestrator rejection without masking by successful siblings', async () => {
    const allFiles = withShiki(syntheticFiles(4))
    let calls = 0
    const seams = makeSeams({
      allFiles,
      execute: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('boom')
        }
        return { kind: 'exited', code: 0 } satisfies ProcessOutcome
      }
    })
    const plan = planRendererRun({ allFiles, cpuCount: 8, env: {} })
    const code = await runRendererWithSeams(seams)
    expect(code).toBe(1)
    expect(calls).toBe(plan.invocations.length)
  })

  it('emits mode, shard/file counts, and durations without loggerService', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    let tick = 1000
    const seams = makeSeams({
      allFiles: withShiki(syntheticFiles(5)),
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      now: () => (tick += 7),
      execute: async () => ({ kind: 'exited', code: 0 })
    })
    const code = await runRendererWithSeams(seams)
    expect(code).toBe(0)
    const out = stdout.join('')
    expect(out).toContain('mode=local')
    expect(out).toContain('shards=')
    expect(out).toContain('files=')
    expect(out).toContain('ms')
    const runnerSource = readRepoFile('scripts/vitest-lanes/runRenderer.ts')
    expect(runnerSource).not.toContain('loggerService')
    const lanesSource = readRepoFile('scripts/vitest-lanes/rendererLanes.ts')
    expect(lanesSource).not.toContain('loggerService')
  })

  it('returns nonzero when enumeration fails closed', async () => {
    const stderr: string[] = []
    const seams = makeSeams({
      allFiles: [],
      stderr: (text: string) => stderr.push(text)
    })
    const code = await runRendererWithSeams(seams)
    expect(code).toBe(1)
    expect(stderr.join('')).toContain('enumeration failed')
  })
})

describe('package.json renderer scripts', () => {
  const pkg = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> }

  it('keeps pnpm test as the single outer lane and the exact suite order', () => {
    expect(pkg.scripts['test']).toBe('pnpm native:run node -- pnpm test:run')
    expect(pkg.scripts['test:run']).toBe(
      [
        'pnpm test:main',
        'pnpm test:renderer',
        'pnpm test:aicore',
        'pnpm test:shared',
        'pnpm test:scripts',
        'pnpm test:e2e-utils'
      ].join(' && ')
    )
  })

  it('keeps test:renderer as a canonical Node-lane command whose child is the TypeScript runner', () => {
    expect(pkg.scripts['test:renderer']).toContain('native:run node')
    expect(pkg.scripts['test:renderer']).not.toContain('native:run electron')
    expect(pkg.scripts['test:renderer:run']).toContain('scripts/vitest-lanes/runRenderer.ts')
    expect(pkg.scripts['test:renderer']).toContain('test:renderer:run')
  })

  it('parses passthrough args with an optional leading -- separator', () => {
    expect(parseExtraArgs(['--update'])).toEqual(['--update'])
    expect(parseExtraArgs(['--', '--update'])).toEqual(['--update'])
    expect(parseExtraArgs([])).toEqual([])
  })
})
