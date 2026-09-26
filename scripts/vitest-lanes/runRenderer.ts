/**
 * Renderer lane runner entry point.
 *
 * Local mode runs the exact renderer test set as deterministic parallel
 * explicit-file shards (N normal + 1 dedicated Shiki) under the one outer
 * Node ABI lease; CI mode runs the single full renderer project invocation.
 * Every Vitest child executes as argv with no shell via the pnpm native-run
 * lane wrapper so it inherits the outer same-lane lease as a nested run. No
 * Electron-as-Node manipulation; Windows pnpm-shim handling reuses the
 * native-abi executor semantics (explicit argv, never a shell string).
 *
 * Diagnostics are concise console lines (mode, shard and file counts,
 * per-shard durations, final status). The application logger is never used
 * in scripts.
 */

import os from 'node:os'

import { createProcessExecutorSeams, executeProcess, type ProcessOutcome } from '../native-abi/executor'
import {
  buildChildArgv,
  CHILD_COMMAND,
  enumerateRendererTestFiles,
  planRendererRun,
  type RendererInvocation,
  type RendererPlan
} from './rendererLanes'

export interface RendererRunSeams {
  enumerate: () => string[]
  cpuCount: () => number
  env: NodeJS.ProcessEnv
  extraArgs: string[]
  execute: (command: string, args: readonly string[]) => Promise<ProcessOutcome>
  stdout: (text: string) => void
  stderr: (text: string) => void
  now: () => number
}

export interface ShardResult {
  invocation: RendererInvocation
  argv: string[]
  outcome: ProcessOutcome
  durationMs: number
}

function outcomeFailed(outcome: ProcessOutcome): boolean {
  if (outcome.kind === 'exited') {
    return outcome.code !== 0
  }
  return true
}

function describeOutcome(outcome: ProcessOutcome): string {
  if (outcome.kind === 'exited') {
    return `exited ${outcome.code}`
  }
  if (outcome.kind === 'signaled') {
    return `signaled ${outcome.signal} (exit ${outcome.exitCode})`
  }
  return `spawn-error ${outcome.message}`
}

/**
 * Orchestrate one renderer run with injected seams. Starts every invocation
 * concurrently, waits for all children, and returns 0 only when every child
 * exited 0. A spawn error, signal, nonzero exit, or orchestrator rejection is
 * fail-closed nonzero; successful siblings never mask a failure.
 */
export async function runRendererWithSeams(seams: RendererRunSeams): Promise<number> {
  const startedAt = seams.now()
  const cpuCount = seams.cpuCount()
  let plan: RendererPlan
  try {
    const allFiles = seams.enumerate()
    plan = planRendererRun({ allFiles, cpuCount, env: seams.env })
  } catch (error) {
    seams.stderr(`[renderer-lanes] enumeration failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const mode = plan.mode
  const ci = mode === 'ci'
  const totalShards = plan.invocations.length
  const normalCount = plan.invocations.filter((invocation) => invocation.kind === 'normal').length
  seams.stdout(
    `[renderer-lanes] mode=${mode} shards=${totalShards} (normal=${normalCount} shiki=${ci ? 0 : 1}) ` +
      `files=${plan.totalFiles} (normal=${plan.normalFiles} shiki=${ci ? 0 : 1}) cpus=${cpuCount} ` +
      `extraArgs=${seams.extraArgs.length === 0 ? 'none' : seams.extraArgs.join(' ')}\n`
  )
  for (const invocation of plan.invocations) {
    seams.stdout(`[renderer-lanes] start ${invocation.label} files=${invocation.files.length}\n`)
  }

  const runOne = async (invocation: RendererInvocation): Promise<ShardResult> => {
    const argv = buildChildArgv(invocation, seams.extraArgs)
    const childStartedAt = seams.now()
    try {
      const outcome = await seams.execute(CHILD_COMMAND, argv)
      return { invocation, argv, outcome, durationMs: seams.now() - childStartedAt }
    } catch (error) {
      const outcome: ProcessOutcome = {
        kind: 'spawn-error',
        message: error instanceof Error ? error.message : String(error)
      }
      return { invocation, argv, outcome, durationMs: seams.now() - childStartedAt }
    }
  }

  // Start every child before awaiting any completion; allSettled waits for all
  // siblings even when one rejects or fails fast.
  const pending = plan.invocations.map((invocation) => runOne(invocation))
  const results = await Promise.all(pending)

  let failed = 0
  for (const result of results) {
    const status = outcomeFailed(result.outcome) ? 'FAIL' : 'PASS'
    if (status === 'FAIL') {
      failed += 1
    }
    seams.stdout(
      `[renderer-lanes] ${status} ${result.invocation.label} files=${result.invocation.files.length} ` +
        `${describeOutcome(result.outcome)} ${result.durationMs}ms\n`
    )
  }

  const totalMs = seams.now() - startedAt
  if (failed > 0) {
    seams.stderr(`[renderer-lanes] result FAIL failed=${failed}/${results.length} totalMs=${totalMs}\n`)
    return 1
  }
  seams.stdout(`[renderer-lanes] result PASS shards=${results.length} totalMs=${totalMs}\n`)
  return 0
}

/** Real wiring: enumeration + CPU + env + native-abi executor (no shell). */
export function createRealSeams(extraArgs: string[]): RendererRunSeams {
  const processSeams = createProcessExecutorSeams()
  return {
    enumerate: () => enumerateRendererTestFiles(),
    cpuCount: () => os.cpus().length,
    env: process.env,
    extraArgs,
    execute: (command, args) =>
      executeProcess(processSeams, {
        command,
        args,
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit'
      }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    now: () => Date.now()
  }
}

/** Parse runner passthrough args (e.g. `--update`); a leading `--` is stripped. */
export function parseExtraArgs(argv: readonly string[]): string[] {
  if (argv.length > 0 && argv[0] === '--') {
    return argv.slice(1)
  }
  return [...argv]
}

async function main(): Promise<void> {
  const extraArgs = parseExtraArgs(process.argv.slice(2))
  process.exitCode = await runRendererWithSeams(createRealSeams(extraArgs))
}

const entry = process.argv[1]
if (entry !== undefined && entry.endsWith('runRenderer.ts')) {
  main().catch((error) => {
    process.stderr.write(`[renderer-lanes] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
