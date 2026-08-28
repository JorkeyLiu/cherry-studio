/**
 * Phase 4 calibration — composite opt-in execution harness (measurement-only).
 *
 * Purpose (LOCK-001..004):
 * - Deliver one cohesive, opt-in public package command that runs the existing
 *   C-01 logical payload calibration, pinned working-set calibration, and the
 *   C-02 mixed Electron heap matrix in the correct ordered runtime lanes,
 *   while preserving their independent schema-v1 artifacts and fail-closed
 *   behavior. Prefer one meaningful end-to-end increment over a fragmented
 *   small commit (LOCK-003).
 *
 * Locked decisions honored:
 * - LOCK-001: Phase 4 remains Open; B-01..B-05 are calibration candidates only.
 * - LOCK-002: Artifacts remain reproducible, privacy-safe schema-v1 outputs.
 * - LOCK-003: One meaningful increment.
 * - LOCK-004: Composite must be explicitly opt-in, run C-01 + pinned in Node
 *   lane then build + C-02 mixed in Electron lane; must not bypass canonical
 *   public lane commands or manually switch ABI.
 *
 * Implementation — smallest coherent public command:
 * - Public package command: `pnpm calibration:phase4` (also aliased
 *   `pnpm bench:phase4-calibration` for bench discoverability).
 * - Sequence uses existing canonical public commands so lane ownership remains
 *   governed by package scripts (native run lanes). No direct vitest bench
 *   invocation, no manual native ABI rebuild, no C02 env leakage beyond its step.
 * - C02 opt-in env `C02_HEAP_CALIBRATION=mixed` applies ONLY to the final
 *   step via cross-platform env merging (spawnSync env), not via shell prefix.
 * - Ordered lanes: Node (C-01), Node (pinned), Electron (build), Electron
 *   (C-02 mixed). Each step is fail-closed — any non-zero exit aborts the
 *   sequence with that exit code and no further steps run.
 * - Independent schema-v1 artifacts: C-01 (`logical-retained-payload-calibration`),
 *   pinned (`pinned-working-set-calibration`), C-02 mixed
 *   (`chatdb-c02-renderer-heap-e2e` with C02 mixed profiles) remain separate
 *   under `test-results/bench-results/` / `test-results/` (gitignored) and are
 *   never mixed or post-processed here.
 * - No automatic/CI invocation — explicit opt-in only.
 *
 * Cross-platform: uses Node `spawnSync` with explicit `env` merging per step;
 * no shell string interpolation, no `VAR=val command` prefix. Consistent with
 * this repository's tsx-script conventions (verify-changed.ts, native-abi/*).
 *
 * Measurement-only: does not close Phase 4/5, does not adopt B-01..B-05,
 * does not create baseline artifacts, does not change IPC/preload/schema/
 * SQLite/StoreSync, does not alter B-06..B-09, does not add CI workflow.
 */

import { spawnSync } from 'node:child_process'

/**
 * Windows cannot execute `.cmd` shims without a shell. When running under a
 * package script, the manager exposes the actual JS entry via `npm_execpath`;
 * on win32 we invoke the current Node executable with that entry plus the
 * canonical pnpm args (argv-based, shell-free). POSIX keeps direct `pnpm`.
 */

export function isValidNpmExecPath(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function resolvePnpmLaunch(
  platform: string = process.platform,
  execPath: string = process.execPath,
  npmExecPath: string | undefined,
  canonicalArgs: readonly string[]
): { command: string; args: readonly string[] } | { error: string } {
  if (platform !== 'win32') {
    return { command: 'pnpm', args: canonicalArgs }
  }
  if (!isValidNpmExecPath(npmExecPath)) {
    return {
      error: `[calibration:phase4] missing or invalid pnpm JS entry (npm_execpath) for Windows launch — got ${JSON.stringify(npmExecPath)}; cannot invoke pnpm without shell`
    }
  }
  return { command: execPath, args: [npmExecPath as string, ...canonicalArgs] }
}

/**
 * Legacy shim — retained for compatibility. Prefer {@link resolvePnpmLaunch}
 * which returns the full argv-aware launcher (Node + npm_execpath on win32,
 * direct pnpm elsewhere). This helper intentionally no longer returns the
 * Windows batch shim; Windows launch is handled via the JS entry.
 */
export function resolvePnpmCommand(_platform: string = process.platform): string {
  return 'pnpm'
}

/**
 * Build child env ensuring C02 isolation: absent for non-final steps even if parent has it,
 * exactly `mixed` for final step. Uses destructuring to explicitly drop any ambient value.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  stepEnv: Readonly<Record<string, string>>,
  isFinal: boolean
): NodeJS.ProcessEnv {
  const parentWithoutC02: Record<string, string | undefined> = { ...parentEnv }
  delete parentWithoutC02.C02_HEAP_CALIBRATION
  if (isFinal) {
    // Final step must be exactly `mixed`, overriding any ambient or step value
    const stepWithoutC02: Record<string, string> = { ...stepEnv }
    delete stepWithoutC02.C02_HEAP_CALIBRATION
    return { ...parentWithoutC02, ...stepWithoutC02, C02_HEAP_CALIBRATION: 'mixed' }
  }
  const stepWithoutC02: Record<string, string> = { ...stepEnv }
  delete stepWithoutC02.C02_HEAP_CALIBRATION
  return { ...parentWithoutC02, ...stepWithoutC02 }
}

// ---------------------------------------------------------------------------
// Public contract — pure, testable, no I/O
// ---------------------------------------------------------------------------

export const PHASE4_CALIBRATION_COMMAND = 'pnpm calibration:phase4'
export const PHASE4_CALIBRATION_ALIAS = 'pnpm bench:phase4-calibration'

/** The 4-step ordered sequence — canonical public commands only. */
export interface CalibrationStep {
  id: string
  command: string
  args: readonly string[]
  /** Extra env for this step only (merged onto process.env). */
  env: Readonly<Record<string, string>>
  lane: 'node' | 'electron'
  description: string
}

export const PHASE4_CALIBRATION_STEPS: readonly CalibrationStep[] = [
  {
    id: 'c01-logical-payload',
    command: 'pnpm',
    args: ['bench:logical-payload'],
    env: {},
    lane: 'node',
    description: 'C-01 logical payload calibration (Node lane, schema-v1 artifact logical-retained-payload-calibration)'
  },
  {
    id: 'pinned-working-set',
    command: 'pnpm',
    args: ['bench:pinned-working-set'],
    env: {},
    lane: 'node',
    description: 'pinned working-set calibration (Node lane, schema-v1 artifact pinned-working-set-calibration)'
  },
  {
    id: 'build',
    command: 'pnpm',
    args: ['build'],
    env: {},
    lane: 'electron',
    description: 'fresh production build establishing Electron lane/ABI (Electron lane, no calibration artifact)'
  },
  {
    id: 'c02-heap-mixed',
    command: 'pnpm',
    args: ['test:e2e', '--', 'tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts'],
    env: { C02_HEAP_CALIBRATION: 'mixed' },
    lane: 'electron',
    description:
      'C-02 mixed Electron heap matrix (Electron lane, schema-v1 artifact chatdb-c02-renderer-heap-e2e, precise-memory flags injected by fixture when env is set)'
  }
] as const

export function getPhase4CalibrationSteps(): readonly CalibrationStep[] {
  return PHASE4_CALIBRATION_STEPS
}

/** Validate that C02 env is isolated to the final step only. */
export function validateC02EnvIsolation(steps: readonly CalibrationStep[]): string[] {
  const problems: string[] = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const hasC02 = 'C02_HEAP_CALIBRATION' in step.env
    if (i < steps.length - 1 && hasC02) {
      problems.push(`step[${i}] ${step.id} must not carry C02_HEAP_CALIBRATION (only final step may)`)
    }
    if (i === steps.length - 1) {
      if (!hasC02) problems.push(`final step ${step.id} must carry C02_HEAP_CALIBRATION=mixed`)
      else if (step.env.C02_HEAP_CALIBRATION !== 'mixed') {
        problems.push(
          `final step ${step.id} C02_HEAP_CALIBRATION must be "mixed", got "${step.env.C02_HEAP_CALIBRATION}"`
        )
      }
    }
  }
  return problems
}

/** Validate canonical public lane commands — must not bypass native:run. */
export function validateCanonicalCommands(steps: readonly CalibrationStep[]): string[] {
  const problems: string[] = []
  const expected: Array<{ id: string; command: string; args: readonly string[] }> = [
    { id: 'c01-logical-payload', command: 'pnpm', args: ['bench:logical-payload'] },
    { id: 'pinned-working-set', command: 'pnpm', args: ['bench:pinned-working-set'] },
    { id: 'build', command: 'pnpm', args: ['build'] },
    {
      id: 'c02-heap-mixed',
      command: 'pnpm',
      args: ['test:e2e', '--', 'tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts']
    }
  ]
  if (steps.length !== expected.length) {
    problems.push(`expected ${expected.length} steps, got ${steps.length}`)
  }
  for (let i = 0; i < Math.min(steps.length, expected.length); i++) {
    const got = steps[i]
    const exp = expected[i]
    if (got.id !== exp.id) problems.push(`step[${i}] id mismatch: expected "${exp.id}", got "${got.id}"`)
    if (got.command !== exp.command)
      problems.push(`step[${i}] command mismatch: expected "${exp.command}", got "${got.command}"`)
    if (JSON.stringify(got.args) !== JSON.stringify(exp.args)) {
      problems.push(`step[${i}] args mismatch: expected ${JSON.stringify(exp.args)}, got ${JSON.stringify(got.args)}`)
    }
    // Ensure no direct bypass (no vitest/playwright/npx/electron invocation outside pnpm public scripts)
    if (got.command !== 'pnpm')
      problems.push(`step[${i}] must use "pnpm" to preserve lane ownership, got "${got.command}"`)
    if (got.args.some((a) => a.includes('native:run') || a.includes('vitest bench') || a.includes('playwright'))) {
      problems.push(
        `step[${i}] must use canonical public package script, not direct native:run/vitest/playwright invocation`
      )
    }
  }
  return problems
}

/** Validate ordered lanes: Node, Node, Electron, Electron. */
export function validateOrderedLanes(steps: readonly CalibrationStep[]): string[] {
  const expectedLanes: Array<CalibrationStep['lane']> = ['node', 'node', 'electron', 'electron']
  const problems: string[] = []
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].lane !== expectedLanes[i]) {
      problems.push(`step[${i}] ${steps[i].id} lane must be "${expectedLanes[i]}", got "${steps[i].lane}"`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Execution — injectable for deterministic tests
// ---------------------------------------------------------------------------

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'inherit'; env: NodeJS.ProcessEnv }
) => { status: number | null; error?: Error; signal?: NodeJS.Signals | null }

export interface CalibrationDeps {
  spawnSyncFn: SpawnSyncFn
  env: NodeJS.ProcessEnv
  stdout: (msg: string) => void
  stderr: (msg: string) => void
  /** Platform override for deterministic tests; defaults to process.platform. */
  platform?: string
  /** Node executable for win32 launch (injectable for tests); defaults to process.execPath. */
  execPath?: string
  /** pnpm JS entry from npm_execpath (injectable for tests); defaults to process.env.npm_execpath. */
  npmExecPath?: string | undefined
}

export const defaultCalibrationDeps: CalibrationDeps = {
  spawnSyncFn: spawnSync as unknown as SpawnSyncFn,
  env: process.env,
  stdout: (msg: string) => process.stdout.write(msg),
  stderr: (msg: string) => process.stderr.write(msg),
  platform: process.platform,
  execPath: process.execPath,
  npmExecPath: process.env.npm_execpath
}

export interface CalibrationResult {
  exitCode: number
  failedStepId: string | null
}

/**
 * Execute the ordered calibration sequence with fail-closed semantics.
 * Returns the deterministic exit code; does not call process.exit.
 */
export function runPhase4Calibration(
  steps: readonly CalibrationStep[] = PHASE4_CALIBRATION_STEPS,
  deps: CalibrationDeps = defaultCalibrationDeps
): CalibrationResult {
  const c02Problems = validateC02EnvIsolation(steps)
  const cmdProblems = validateCanonicalCommands(steps)
  const laneProblems = validateOrderedLanes(steps)
  const allProblems = [...c02Problems, ...cmdProblems, ...laneProblems]
  if (allProblems.length > 0) {
    for (const p of allProblems) deps.stderr(`[calibration:phase4] contract violation: ${p}\n`)
    return { exitCode: 1, failedStepId: '__contract__' }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const isFinal = i === steps.length - 1
    const stepEnv = buildChildEnv(deps.env, step.env, isFinal)
    const platform = deps.platform ?? process.platform
    const execPath = deps.execPath ?? process.execPath
    const npmExecPath = 'npmExecPath' in deps ? deps.npmExecPath : process.env.npm_execpath
    const launch = resolvePnpmLaunch(platform, execPath, npmExecPath, step.args)
    if ('error' in launch) {
      deps.stderr(`${launch.error}\n`)
      deps.stderr(`[calibration:phase4] step ${step.id} aborted before spawn: invalid Windows pnpm launcher\n`)
      return { exitCode: 1, failedStepId: step.id }
    }
    const spawnCommand = launch.command
    const spawnArgs = launch.args
    deps.stdout(`\n[calibration:phase4] step ${i + 1}/${steps.length} — ${step.id} (${step.lane} lane)\n`)
    deps.stdout(`  command: ${spawnCommand} ${spawnArgs.join(' ')}\n`)
    if (Object.keys(step.env).length > 0) {
      deps.stdout(
        `  env: ${Object.entries(step.env)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}\n`
      )
    }
    deps.stdout(`  description: ${step.description}\n`)

    let result: ReturnType<SpawnSyncFn>
    try {
      result = deps.spawnSyncFn(spawnCommand, spawnArgs, { stdio: 'inherit', env: stepEnv })
    } catch (error) {
      deps.stderr(
        `[calibration:phase4] step ${step.id} spawn threw: ${error instanceof Error ? error.message : String(error)}\n`
      )
      return { exitCode: 1, failedStepId: step.id }
    }

    if (result.error) {
      deps.stderr(`[calibration:phase4] step ${step.id} failed to spawn: ${result.error.message}\n`)
      return { exitCode: 1, failedStepId: step.id }
    }
    if (result.signal != null) {
      deps.stderr(`[calibration:phase4] step ${step.id} terminated by signal ${result.signal}\n`)
      return { exitCode: 1, failedStepId: step.id }
    }
    if (result.status == null) {
      deps.stderr(`[calibration:phase4] step ${step.id} exited with null status (unknown)\n`)
      return { exitCode: 1, failedStepId: step.id }
    }
    if (result.status !== 0) {
      deps.stderr(
        `[calibration:phase4] step ${step.id} exited with code ${result.status} — aborting remaining steps (fail-closed)\n`
      )
      return { exitCode: result.status, failedStepId: step.id }
    }
    deps.stdout(`[calibration:phase4] step ${step.id} completed successfully\n`)
  }

  deps.stdout('\n[calibration:phase4] all steps completed successfully\n')
  deps.stdout('Artifacts (gitignored, independent, privacy-safe schema-v1):\n')
  deps.stdout('  - test-results/bench-results/logical-retained-payload-calibration-*.json (C-01)\n')
  deps.stdout('  - test-results/bench-results/pinned-working-set-calibration-*.json (pinned)\n')
  deps.stdout(
    '  - test-results/bench-results/chatdb-c02-renderer-heap-e2e-*.json (C-02 mixed, written via fresh production build/Electron lane)\n'
  )
  deps.stdout('Measurement-only: does not close Phase 4, does not adopt B-01..B-05, does not create baselines.\n')
  return { exitCode: 0, failedStepId: null }
}

function printUsage(): void {
  console.log(
    `
Usage: pnpm calibration:phase4
   or: pnpm bench:phase4-calibration

Runs the Phase 4 calibration sequence in correct ordered lanes (measurement-only, opt-in, fail-closed):

  1. pnpm bench:logical-payload                          (Node lane, ABI 137) — C-01
  2. pnpm bench:pinned-working-set                       (Node lane, ABI 137) — pinned
  3. pnpm build                                           (Electron lane, ABI 145) — fresh production build
  4. pnpm test:e2e -- tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts
      (with C02_HEAP_CALIBRATION=mixed, Electron lane, ABI 145) — C-02 mixed

Each step uses its canonical public package command so lane ownership stays
governed by package scripts; no manual ABI switching, no shell env prefix
leakage (C02 env only for step 4, cross-platform). Fail-closed: any non-zero
exit aborts remaining steps. Independent schema-v1 artifacts preserved under
test-results/ (gitignored). No CI auto-invocation, no thresholds, no policy
adoption.`.trim()
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    process.exitCode = 0
    return
  }
  const result = runPhase4Calibration()
  process.exitCode = result.exitCode
  if (result.exitCode !== 0 && result.failedStepId) {
    console.error(
      `\n[calibration:phase4] calibration failed at step "${result.failedStepId}" with exit ${result.exitCode} (fail-closed, no policy adopted)\n`
    )
  }
}

const entry = process.argv[1]
if (entry != null && (entry.endsWith('calibration-phase4.ts') || entry.endsWith('calibration-phase4.js'))) {
  main().catch((error) => {
    console.error(`[calibration:phase4] fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
