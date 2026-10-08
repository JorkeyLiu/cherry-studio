import { describe, expect, it } from 'vitest'

import type { RunRuntimeResult } from '../run'
import { formatRunResult, parseRunArgs, runCli } from '../run-cli'

/**
 * Focused regression coverage for the `native:run` CLI
 * (scripts/native-runtime/run-cli.ts):
 *
 *  - argv parsing requires an explicit target and the mandatory `--`
 *    separator; the command + argv pass through verbatim (no shell);
 *  - diagnostics stay concise and never dump environments;
 *  - the structured result's exit code is preserved verbatim;
 *  - usage errors exit 2 and runner rejections exit 1.
 */

describe('parseRunArgs', () => {
  it('parses an explicit target, command, and verbatim argv', () => {
    expect(parseRunArgs(['node', '--', 'pnpm', 'vitest', 'run'])).toEqual({
      ok: true,
      target: 'node',
      command: 'pnpm',
      args: ['vitest', 'run']
    })
    expect(parseRunArgs(['electron', '--', 'pnpm', 'build'])).toEqual({
      ok: true,
      target: 'electron',
      command: 'pnpm',
      args: ['build']
    })
  })

  it('rejects an invalid target', () => {
    const parsed = parseRunArgs(['bun', '--', 'pnpm', 'test'])
    expect(parsed.ok).toBe(false)
  })

  it('rejects a missing separator', () => {
    const parsed = parseRunArgs(['node', 'pnpm', 'test'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain("'--'")
  })

  it('rejects a missing command', () => {
    expect(parseRunArgs(['node', '--']).ok).toBe(false)
    expect(parseRunArgs([]).ok).toBe(false)
  })
})

describe('formatRunResult', () => {
  it('formats a completed success with no stderr', () => {
    const diagnostics = formatRunResult({
      status: 'completed',
      target: 'node',
      child: { kind: 'exited', code: 0 },
      exitCode: 0
    })
    expect(diagnostics.stdout).toContain('native:run node')
    expect(diagnostics.stdout).toContain('completed')
    expect(diagnostics.stderr).toBe('')
  })

  it('formats a probe failure with remediation and no environment dump', () => {
    const diagnostics = formatRunResult({
      status: 'probe-failure',
      target: 'electron',
      error: 'probe boom',
      exitCode: 1
    })
    // Exactly the probe line plus the remediation line — nothing else (in
    // particular, no environment dump) may reach stderr.
    expect(diagnostics.stderr).toBe(
      `${'probe:'.padEnd(18)}probe boom\n${'action:'.padEnd(18)}re-run \`pnpm install\` to restore the locked better-sqlite3 prebuilds, then retry\n`
    )
  })

  it('formats a failing child with its outcome', () => {
    const diagnostics = formatRunResult({
      status: 'completed',
      target: 'node',
      child: { kind: 'exited', code: 3 },
      exitCode: 3
    })
    expect(diagnostics.stderr).toContain('exited 3')
  })
})

describe('runCli', () => {
  function collector(): {
    stdout: string[]
    stderr: string[]
    io: { stdout: (t: string) => void; stderr: (t: string) => void }
  } {
    const stdout: string[] = []
    const stderr: string[] = []
    return { stdout, stderr, io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) } }
  }

  it('returns usage error 2 without invoking the runner', async () => {
    const c = collector()
    let called = 0
    const code = await runCli(
      ['bogus'],
      async () => {
        called += 1
        return { status: 'completed', target: 'node', child: { kind: 'exited', code: 0 }, exitCode: 0 }
      },
      c.io
    )
    expect(code).toBe(2)
    expect(called).toBe(0)
    expect(c.stderr.join('')).toContain(
      'usage: tsx scripts/native-runtime/run-cli.ts <node|electron> -- <command> [args...]'
    )
  })

  it('preserves the structured exit code verbatim', async () => {
    const c = collector()
    const result: RunRuntimeResult = {
      status: 'completed',
      target: 'node',
      child: { kind: 'exited', code: 42 },
      exitCode: 42
    }
    const code = await runCli(['node', '--', 'whatever', 'x'], async () => result, c.io)
    expect(code).toBe(42)
    expect(c.stdout.join('')).toContain('native:run node')
  })

  it('maps a runner rejection to exit 1 with a concise error', async () => {
    const c = collector()
    const code = await runCli(
      ['node', '--', 'cmd'],
      async () => {
        throw new Error('runner exploded')
      },
      c.io
    )
    expect(code).toBe(1)
    expect(c.stderr.join('')).toContain('runner exploded')
  })
})
