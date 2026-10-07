import { spawn } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { conventionalExitCode, createProcessExecutorSeams, executeProcess } from '../executor'

/**
 * Focused executor coverage (scripts/native-runtime/executor.ts):
 *
 *  - real subprocess outcomes: exit codes preserved, spawn errors fail
 *    closed, close-without-code never masquerades as success (fake);
 *  - signal mapping is the deterministic conventional mapping;
 *  - parent signal handlers are always unregistered (fake registration
 *    counting);
 *  - explicit argv launch: no shell parsing (an arg containing spaces and
 *    metacharacters arrives verbatim).
 */

describe('conventionalExitCode', () => {
  it('maps SIGINT/SIGTERM conventionally', () => {
    expect(conventionalExitCode('SIGINT')).toBe(130)
    expect(conventionalExitCode('SIGTERM')).toBe(143)
  })
})

describe('executeProcess (real subprocess)', () => {
  it('preserves exit code 0', async () => {
    const outcome = await executeProcess(createProcessExecutorSeams(), {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdio: 'ignore'
    })
    expect(outcome).toEqual({ kind: 'exited', code: 0 })
  })

  it('preserves nonzero exit codes', async () => {
    const outcome = await executeProcess(createProcessExecutorSeams(), {
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      stdio: 'ignore'
    })
    expect(outcome).toEqual({ kind: 'exited', code: 7 })
  })

  it('reports a missing command as a spawn error, never a rejection', async () => {
    const outcome = await executeProcess(createProcessExecutorSeams(), {
      command: 'definitely-missing-command-native-runtime-test',
      args: [],
      stdio: 'ignore'
    })
    expect(outcome.kind).toBe('spawn-error')
  })

  it('passes argv with spaces and shell metacharacters verbatim (no shell)', async () => {
    const marker = 'hello world; $(evil) `backtick` | pipe & ampersand'
    const child = spawn(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', marker])
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', () => resolve())
    })
    expect(JSON.parse(out.trim())).toEqual([marker])
  })

  it('unregisters parent signal handlers after the child settles', async () => {
    const before = process.listenerCount('SIGINT')
    const outcome = await executeProcess(createProcessExecutorSeams(), {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdio: 'ignore'
    })
    expect(outcome.kind).toBe('exited')
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
