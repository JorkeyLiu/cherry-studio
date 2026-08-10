/**
 * Focused regression coverage for the `native:run` CLI (scripts/native-abi/run-cli.ts).
 *
 * The CLI is a thin, fully injectable wrapper over the tested `runLane`
 * coordinator: a pure argv parser (`parseRunArgs`), a pure concise diagnostic
 * formatter (`formatRunResult`), and the CLI logic (`runCli`) with an injected
 * runner and stdout/stderr seam. These tests never touch native bindings,
 * spawn real package commands, or hold locks — the runner is always a fake
 * returning scripted `RunLaneResult` fixtures.
 *
 * Behavior covered:
 *  - parsing: explicit `node|electron` lane, mandatory `--` separator, non-empty
 *    command, verbatim argv forwarding;
 *  - usage errors exit 2, print usage to stderr, and never call the runner;
 *  - the runner receives the exact lane/command/args plus the inherited
 *    cwd/env, and the returned final exit code is preserved verbatim across
 *    representative result variants (nested exited/signaled/spawn-error, lane
 *    conflict, preparation failures, outer child/restore/release failures,
 *    target-lane-failure, success);
 *  - an unexpected runner rejection returns 1 with a concise error (no stack);
 *  - diagnostics are concise and redacted: the lock/lease ownership token and
 *    environment variables are never dumped, and long diagnostics are clipped.
 *
 * Diagnostic assertions match lines by `label:\s+value` (report.ts pads labels
 * to a fixed width) so the exact padding width is not part of the contract.
 */

import { describe, expect, it } from 'vitest'

import type { ProcessOutcome } from '../executor'
import type { FinalizeOuterLaneResult } from '../finalize'
import type { LaneId, LockAcquireResult, LockOwner } from '../lock'
import type { PreparationFailureReason } from '../prepare'
import type {
  FinalizerSignal,
  LaneConflictRunResult,
  NestedRunResult,
  OuterRunResult,
  PreparationFailureRunResult,
  RunLaneOptions,
  RunLaneResult,
  TargetLaneFailureRunResult
} from '../run'
import { formatRunResult, parseRunArgs, runCli, type RunCliIo, type RunRunner } from '../run-cli'
import type { CheckReport } from '../types'

// ---------------------------------------------------------------------------
// Deterministic fixtures: every variant of the `runLane` result contract with
// a distinctive ownership token that must never appear in diagnostics.
// ---------------------------------------------------------------------------

const CHECKOUT = '/checkout/root'
const LOCK_PATH = `${CHECKOUT}/.native-abi-lock`
const TOKEN = 'LOCK-OWNERSHIP-TOKEN-7f3a9c'

function checkReport(lane: LaneId, ok = true): CheckReport {
  return {
    target: lane,
    ok,
    runtimeName: lane === 'electron' ? 'electron' : 'node',
    runtimeVersion: lane === 'electron' ? '41.2.1' : '24.11.1',
    abi: lane === 'electron' ? 145 : 137,
    platform: 'darwin',
    arch: 'arm64',
    markerState: 'ignored',
    sqlVerified: ok,
    failures: ok ? [] : ['probe failed']
  }
}

function owner(lane: LaneId): LockOwner {
  return { pid: 4242, token: TOKEN, lane, checkoutRoot: CHECKOUT, timestamp: 1_700_000_000_000 }
}

function acquire(lane: LaneId): LockAcquireResult & { acquired: true } {
  return { acquired: true, owner: owner(lane), lockPath: LOCK_PATH }
}

function finalize(partial: Partial<FinalizeOuterLaneResult> = {}): FinalizeOuterLaneResult {
  return {
    lane: 'node',
    child: { ran: true, outcome: { kind: 'exited', code: 0 } },
    restore: { status: 'skipped', reason: 'ci-skip' },
    release: { released: true, lockPath: LOCK_PATH },
    exitCode: 0,
    ...partial
  }
}

function nestedFixture(child: ProcessOutcome, exitCode: number, lifecycleSignal?: FinalizerSignal): NestedRunResult {
  return {
    status: 'nested',
    lane: 'node',
    checkoutRoot: CHECKOUT,
    lease: { version: 1, owner: owner('node') },
    child,
    ...(lifecycleSignal !== undefined ? { lifecycleSignal } : {}),
    exitCode
  }
}

function conflictFixture(requestedLane: LaneId, leaseLane: LaneId): LaneConflictRunResult {
  return {
    status: 'lane-conflict',
    lane: requestedLane,
    checkoutRoot: CHECKOUT,
    lease: { version: 1, owner: owner(leaseLane) },
    exitCode: 5
  }
}

function preparationFailureFixture(reason: PreparationFailureReason): PreparationFailureRunResult {
  return {
    status: 'preparation-failure',
    lane: 'node',
    checkoutRoot: CHECKOUT,
    reason,
    exitCode: 6
  }
}

function outerFixture(partial: Partial<OuterRunResult> = {}): OuterRunResult {
  return {
    status: 'outer',
    lane: 'node',
    checkoutRoot: CHECKOUT,
    acquire: acquire('node'),
    owner: owner('node'),
    token: TOKEN,
    lockPath: LOCK_PATH,
    ensure: { status: 'ok', lane: 'node', rebuilt: false, check: checkReport('node'), verify: checkReport('node') },
    finalize: finalize(),
    exitCode: 0,
    ...partial
  }
}

function targetLaneFailureFixture(partial: Partial<TargetLaneFailureRunResult> = {}): TargetLaneFailureRunResult {
  return {
    status: 'target-lane-failure',
    lane: 'node',
    checkoutRoot: CHECKOUT,
    acquire: acquire('node'),
    owner: owner('node'),
    token: TOKEN,
    lockPath: LOCK_PATH,
    ensure: { status: 'rejected', error: 'lane ensure rejected: rebuild failed' },
    finalize: finalize({
      child: {
        ran: false,
        reason: 'target-preparation-failure',
        error: 'lane rebuild failed: rebuild did not produce a verified binding'
      },
      exitCode: 2
    }),
    exitCode: 2,
    ...partial
  }
}

// ---------------------------------------------------------------------------
// Capture seam + runner helpers
// ---------------------------------------------------------------------------

function captureIo(): { io: RunCliIo; stdout: () => string; stderr: () => string } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text)
    },
    stdout: () => out.join(''),
    stderr: () => err.join('')
  }
}

/** Run the CLI with a fake runner returning `result`; return code + captured output. */
async function runWith(
  result: RunLaneResult,
  argv: readonly string[] = ['node', '--', 'pnpm', 'test']
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = captureIo()
  const code = await runCli(argv, async () => result, io)
  return { code, stdout: stdout(), stderr: stderr() }
}

// ---------------------------------------------------------------------------
// parseRunArgs
// ---------------------------------------------------------------------------

describe('parseRunArgs', () => {
  it('parses a node lane with a command and forwarded args', () => {
    expect(parseRunArgs(['node', '--', 'pnpm', '--filter', 'core', 'test'])).toEqual({
      ok: true,
      lane: 'node',
      command: 'pnpm',
      args: ['--filter', 'core', 'test']
    })
  })

  it('parses an electron lane with a command and no args', () => {
    expect(parseRunArgs(['electron', '--', 'node', 'probe.cjs'])).toEqual({
      ok: true,
      lane: 'electron',
      command: 'node',
      args: ['probe.cjs']
    })
  })

  it('keeps a single-command argv with zero args', () => {
    expect(parseRunArgs(['node', '--', 'ls'])).toEqual({ ok: true, lane: 'node', command: 'ls', args: [] })
  })

  it('forwards every token after the command verbatim', () => {
    expect(parseRunArgs(['node', '--', 'pnpm', '--', 'weird', '--flag=1', ''])).toEqual({
      ok: true,
      lane: 'node',
      command: 'pnpm',
      args: ['--', 'weird', '--flag=1', '']
    })
  })

  it('rejects empty argv', () => {
    expect(parseRunArgs([])).toEqual({ ok: false, error: expect.stringContaining('invalid lane') })
  })

  it('rejects a missing separator', () => {
    expect(parseRunArgs(['node'])).toEqual({ ok: false, error: expect.stringContaining("'--'") })
    expect(parseRunArgs(['node', 'check'])).toEqual({ ok: false, error: expect.stringContaining("'--'") })
  })

  it('rejects an unknown lane', () => {
    expect(parseRunArgs(['native', '--', 'ls'])).toEqual({
      ok: false,
      error: expect.stringContaining("invalid lane 'native'")
    })
  })

  it('rejects a missing command after the separator', () => {
    expect(parseRunArgs(['node', '--'])).toEqual({ ok: false, error: expect.stringContaining('missing command') })
  })

  it('rejects an empty-string command', () => {
    expect(parseRunArgs(['node', '--', ''])).toEqual({ ok: false, error: expect.stringContaining('missing command') })
  })
})

// ---------------------------------------------------------------------------
// runCli — usage errors
// ---------------------------------------------------------------------------

describe('runCli — usage errors (exit 2)', () => {
  async function expectUsageError(argv: readonly string[]): Promise<void> {
    const { io, stderr } = captureIo()
    let runnerCalled = false
    const runner: RunRunner = async () => {
      runnerCalled = true
      throw new Error('runner must not be called on a usage error')
    }
    const code = await runCli(argv, runner, io)
    expect(code).toBe(2)
    expect(runnerCalled).toBe(false)
    expect(stderr()).toContain('usage: tsx scripts/native-abi/run-cli.ts <node|electron> -- <command> [args...]')
  }

  it('no args', async () => expectUsageError([]))
  it('missing separator', async () => expectUsageError(['node']))
  it('lane without separator', async () => expectUsageError(['node', 'check']))
  it('unknown lane', async () => expectUsageError(['native', '--', 'ls']))
  it('missing command after the separator', async () => expectUsageError(['node', '--']))
  it('empty-string command', async () => expectUsageError(['node', '--', '']))
})

// ---------------------------------------------------------------------------
// runCli — argv forwarding
// ---------------------------------------------------------------------------

describe('runCli — argv forwarding', () => {
  it('forwards the exact lane, command, args, and inherited cwd/env to the runner', async () => {
    const calls: RunLaneOptions[] = []
    const runner: RunRunner = async (options) => {
      calls.push(options)
      return nestedFixture({ kind: 'exited', code: 0 }, 0)
    }
    const { io } = captureIo()
    const code = await runCli(['node', '--', 'pnpm', '--filter', 'core', 'test'], runner, io)
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      lane: 'node',
      command: 'pnpm',
      args: ['--filter', 'core', 'test'],
      cwd: process.cwd(),
      env: process.env
    })
  })

  it('forwards an electron lane command', async () => {
    const calls: RunLaneOptions[] = []
    const runner: RunRunner = async (options) => {
      calls.push(options)
      return conflictFixture('electron', 'node')
    }
    const { io } = captureIo()
    const code = await runCli(['electron', '--', 'node', 'x.js'], runner, io)
    expect(code).toBe(5)
    expect(calls[0]?.lane).toBe('electron')
    expect(calls[0]?.command).toBe('node')
    expect(calls[0]?.args).toEqual(['x.js'])
  })
})

// ---------------------------------------------------------------------------
// runCli — exit-code preservation and diagnostics
// ---------------------------------------------------------------------------

describe('runCli — exit-code preservation and diagnostics', () => {
  it('nested: preserves a failing child exit code with a child diagnostic', async () => {
    const { code, stdout, stderr } = await runWith(nestedFixture({ kind: 'exited', code: 7 }, 7))
    expect(code).toBe(7)
    expect(stdout).toMatch(/status:\s+nested/)
    expect(stdout).toMatch(/exit:\s+7/)
    expect(stderr).toMatch(/child:\s+exited 7/)
  })

  it('nested: preserves a signaled child with its conventional exit code', async () => {
    const { code, stderr } = await runWith(nestedFixture({ kind: 'signaled', signal: 'SIGTERM', exitCode: 143 }, 143))
    expect(code).toBe(143)
    expect(stderr).toMatch(/child:\s+signaled SIGTERM \(exit 143\)/)
  })

  it('nested: maps a spawn error to exit 1 and clips the diagnostic', async () => {
    const message = `spawn pnpm ENOENT: ${'x'.repeat(300)}`
    const { code, stderr } = await runWith(nestedFixture({ kind: 'spawn-error', message }, 1))
    expect(code).toBe(1)
    expect(stderr).toMatch(/child:\s+spawn error:/)
    expect(stderr).toContain('...')
    expect(stderr.length).toBeLessThan(300)
  })

  it('nested: a successful run stays quiet on stderr', async () => {
    const { code, stdout, stderr } = await runWith(nestedFixture({ kind: 'exited', code: 0 }, 0))
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toMatch(/status:\s+nested/)
    expect(stdout).toMatch(/exit:\s+0/)
  })

  it('nested: a child that exits 0 after a captured signal yields the signal exit code', async () => {
    const { code, stderr } = await runWith(
      nestedFixture({ kind: 'exited', code: 0 }, 130, { signal: 'SIGINT', exitCode: 130 })
    )
    expect(code).toBe(130)
    expect(stderr).toMatch(/signal:\s+captured SIGINT \(exit 130\)/)
    expect(stderr).not.toMatch(/child:\s+exited 0/)
  })

  it('lane conflict: returns 5 with an actionable conflict diagnostic', async () => {
    const { code, stderr } = await runWith(conflictFixture('node', 'electron'))
    expect(code).toBe(5)
    expect(stderr).toMatch(/conflict:\s+a valid electron lane lease holds checkout \/checkout\/root/)
    expect(stderr).toMatch(/action:\s+/)
  })

  it('preparation root-resolution failure: returns 6 with the diagnostic', async () => {
    const { code, stderr } = await runWith(
      preparationFailureFixture({
        kind: 'root-resolution',
        detail: 'cannot resolve the checkout root from the project root'
      })
    )
    expect(code).toBe(6)
    expect(stderr).toMatch(/preparation:\s+cannot resolve the checkout root/)
  })

  it('preparation lock-acquire failure: returns 6 with the holder lane, never the owner metadata', async () => {
    const { code, stderr } = await runWith(
      preparationFailureFixture({
        kind: 'lock-acquire',
        acquire: { acquired: false, reason: 'locked', owner: owner('electron'), lockPath: LOCK_PATH }
      })
    )
    expect(code).toBe(6)
    expect(stderr).toMatch(/lock:\s+locked - held by another electron lane/)
    expect(stderr).toMatch(/lock path:\s+\/checkout\/root\/\.native-abi-lock/)
  })

  it('preparation lock-acquire error: returns 6 with the diagnostic', async () => {
    const { code, stderr } = await runWith(
      preparationFailureFixture({
        kind: 'lock-acquire',
        acquire: { acquired: false, reason: 'error', error: 'lock file read failed: EACCES', lockPath: LOCK_PATH }
      })
    )
    expect(code).toBe(6)
    expect(stderr).toMatch(/lock:\s+lock file read failed: EACCES/)
  })

  it('outer: preserves a failing child exit code', async () => {
    const { code, stderr } = await runWith(
      outerFixture({
        exitCode: 7,
        finalize: finalize({ child: { ran: true, outcome: { kind: 'exited', code: 7 } }, exitCode: 7 })
      })
    )
    expect(code).toBe(7)
    expect(stderr).toMatch(/child:\s+exited 7/)
  })

  it('outer: a failed restoration returns 3', async () => {
    const { code, stderr } = await runWith(
      outerFixture({ exitCode: 3, finalize: finalize({ restore: { status: 'performed', ok: false }, exitCode: 3 }) })
    )
    expect(code).toBe(3)
    expect(stderr).toMatch(/restore:\s+FAIL \(Electron ABI 145 restoration did not pass\)/)
  })

  it('outer: a rejected restoration returns 3 with the rejection reason', async () => {
    const { code, stderr } = await runWith(
      outerFixture({
        exitCode: 3,
        finalize: finalize({ restore: { status: 'rejected', error: 'restore seam rejected' }, exitCode: 3 })
      })
    )
    expect(code).toBe(3)
    expect(stderr).toMatch(/restore:\s+rejected: restore seam rejected/)
  })

  it('outer: a failed release returns 4', async () => {
    const { code, stderr } = await runWith(
      outerFixture({
        exitCode: 4,
        finalize: finalize({ release: { released: false, reason: 'not-owner', lockPath: LOCK_PATH }, exitCode: 4 })
      })
    )
    expect(code).toBe(4)
    expect(stderr).toMatch(/release:\s+FAIL \(not-owner\)/)
  })

  it('outer: a successful run prints exactly the status block and stays quiet on stderr', async () => {
    const { code, stdout, stderr } = await runWith(outerFixture())
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toMatch(/^command:\s+native:run node\nstatus:\s+outer\nexit:\s+0\n$/)
  })

  it('outer: a failing child stays authoritative over a captured signal', async () => {
    const { code, stderr } = await runWith(
      outerFixture({
        exitCode: 7,
        finalize: finalize({ child: { ran: true, outcome: { kind: 'exited', code: 7 } }, exitCode: 7 }),
        lifecycleSignal: { signal: 'SIGINT', exitCode: 130 }
      })
    )
    expect(code).toBe(7)
    expect(stderr).toMatch(/child:\s+exited 7/)
    expect(stderr).toMatch(/signal:\s+captured SIGINT \(exit 130\)/)
  })

  it('outer: a signal on a successful child surfaces the signal without a child line', async () => {
    const { code, stderr } = await runWith(
      outerFixture({
        exitCode: 130,
        finalize: finalize({ exitCode: 130 }),
        lifecycleSignal: { signal: 'SIGINT', exitCode: 130 }
      })
    )
    expect(code).toBe(130)
    expect(stderr).toMatch(/signal:\s+captured SIGINT \(exit 130\)/)
    expect(stderr).not.toMatch(/child:/)
  })

  it('target-lane-failure: returns 2 with the preserved lane diagnostic', async () => {
    const { code, stdout, stderr } = await runWith(targetLaneFailureFixture())
    expect(code).toBe(2)
    expect(stdout).toMatch(/status:\s+target-lane-failure/)
    expect(stderr).toMatch(/target lane:\s+lane rebuild failed: rebuild did not produce a verified binding/)
  })
})

// ---------------------------------------------------------------------------
// runCli — unexpected rejection
// ---------------------------------------------------------------------------

describe('runCli — unexpected rejection', () => {
  it('returns 1 and prints a concise error to stderr (no stack dump)', async () => {
    const { io, stderr } = captureIo()
    const runner: RunRunner = async () => {
      throw new Error('coordinator exploded')
    }
    const code = await runCli(['node', '--', 'pnpm', 'test'], runner, io)
    expect(code).toBe(1)
    expect(stderr()).toContain('native:run error: coordinator exploded')
    expect(stderr()).not.toContain('    at ')
  })
})

// ---------------------------------------------------------------------------
// runCli — redaction (no token / no owner metadata / no env dump)
// ---------------------------------------------------------------------------

describe('runCli — redaction (no token / no env dump)', () => {
  it('never prints the ownership token or the word "token" for any failing variant', async () => {
    const variants: RunLaneResult[] = [
      outerFixture({
        exitCode: 4,
        finalize: finalize({
          release: { released: false, reason: 'error', error: 'release failed: EACCES', lockPath: LOCK_PATH },
          exitCode: 4
        })
      }),
      targetLaneFailureFixture(),
      conflictFixture('node', 'electron'),
      preparationFailureFixture({
        kind: 'lock-acquire',
        acquire: { acquired: false, reason: 'locked', owner: owner('electron'), lockPath: LOCK_PATH }
      }),
      preparationFailureFixture({
        kind: 'lock-acquire-rejected',
        error: 'acquire rejected: timeout',
        lockPath: LOCK_PATH
      })
    ]
    for (const result of variants) {
      const { code, stdout, stderr } = await runWith(result)
      expect(code).not.toBe(0)
      const combined = `${stdout}${stderr}`
      expect(combined).not.toContain(TOKEN)
      expect(combined).not.toContain('token')
    }
  })

  it('never dumps environment variables', async () => {
    const key = 'NATIVE_ABI_RUN_CLI_TEST_SECRET'
    const previous = process.env[key]
    process.env[key] = 'SUPER-SECRET-ENV-VALUE'
    try {
      const { code, stdout, stderr } = await runWith(nestedFixture({ kind: 'exited', code: 0 }, 0))
      expect(code).toBe(0)
      const combined = `${stdout}${stderr}`
      expect(combined).not.toContain('SUPER-SECRET-ENV-VALUE')
      expect(combined).not.toContain(key)
    } finally {
      if (previous === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous
      }
    }
  })
})

// ---------------------------------------------------------------------------
// formatRunResult (exact deterministic output)
// ---------------------------------------------------------------------------

describe('formatRunResult', () => {
  it('returns an empty stderr block and the exact status block for a successful nested run', () => {
    const diagnostics = formatRunResult(nestedFixture({ kind: 'exited', code: 0 }, 0))
    expect(diagnostics.stderr).toBe('')
    expect(diagnostics.stdout).toMatch(/^command:\s+native:run node\nstatus:\s+nested\nexit:\s+0\n$/)
  })

  it('returns the actionable conflict lines on stderr for a lane conflict', () => {
    const diagnostics = formatRunResult(conflictFixture('node', 'electron'))
    expect(diagnostics.stdout).toMatch(/status:\s+lane-conflict/)
    expect(diagnostics.stderr).toMatch(
      /^conflict:\s+a valid electron lane lease holds checkout \/checkout\/root\naction:\s+wait for the electron lane to release its lock, or run the electron lane command\n$/
    )
  })
})
