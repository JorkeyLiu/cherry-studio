import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { runElectronCheck } from '../check'
import { NATIVE_PACKAGE_VERSION, PROBE_TIMEOUT_MS } from '../constants'
import { createEffects, spawnNodeProbe } from '../effects'
import { PROBE_FAILURE_EXIT_CODE, runRuntime } from '../run'
import type { Effects } from '../types'

/**
 * Bounded diagnostic timeout (F1):
 *
 *  - the probe timeout is explicit and within the 30-60s diagnostic bound;
 *  - a hung Electron/Node probe child is terminated and fails closed as a
 *    probe failure (no retry, no spawn of the child command, nonzero exit).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const HANG = path.join(here, 'fixtures', 'hang.cjs')

describe('bounded probe timeout', () => {
  it('timeout is explicit and within the 30-60s diagnostic bound', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(30000)
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(60000)
  })

  it('a hung Electron probe child times out (bounded, nonzero, no output proof)', () => {
    const effects = createEffects()
    const startedAt = Date.now()
    const res = effects.spawnElectronProbe(process.execPath, HANG, 500)
    const elapsedMs = Date.now() - startedAt
    expect(res.timedOut).toBe(true)
    expect(res.code).not.toBe(0)
    // Bounded: terminates far below the 60s production bound.
    expect(elapsedMs).toBeLessThan(10000)
  }, 15000)

  it('a hung Node probe child fails closed with a timeout cause', () => {
    const result = spawnNodeProbe(HANG, {}, 500)
    expect(result.ok).toBe(false)
    expect(result.sqlOk).toBe(false)
    expect(result.error).toContain('timed out')
    expect(result.error).toContain('no retry')
  }, 15000)

  it('a timed-out Electron probe never spawns the child (nonzero probe-failure)', async () => {
    const base = createEffects()
    const effects: Effects = {
      ...base,
      electronBinPath: () => '/electron',
      spawnElectronProbe: () => ({ code: 1, stdout: '', stderr: '', timedOut: true })
    }
    const spawn = vi.fn(() => {
      throw new Error('must not spawn')
    })
    const result = await runRuntime({
      target: 'electron',
      command: 'pnpm',
      args: ['build'],
      env: {},
      effects,
      processSeams: { spawn: spawn as never, onSignal: () => () => {} }
    })
    expect(result.status).toBe('probe-failure')
    if (result.status !== 'probe-failure') throw new Error('unreachable')
    expect(result.error).toContain('timed out')
    expect(result.error).toContain('no retry')
    expect(result.exitCode).toBe(PROBE_FAILURE_EXIT_CODE)
    expect(result.exitCode).not.toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runElectronCheck maps a probe timeout to a fail-closed timeout cause', () => {
    const base = createEffects()
    const effects: Effects = {
      ...base,
      runtimeInfo: () => ({
        runtime: 'node',
        nodeVersion: '24.11.1',
        modulesAbi: 137,
        platform: 'darwin',
        arch: 'arm64',
        execPath: '/node'
      }),
      readJson: () => ({ version: NATIVE_PACKAGE_VERSION }),
      realpath: (p) => `/real${p}`,
      resolvePackageJsonPath: () => '/repo/node_modules/better-sqlite3/package.json',
      electronBinPath: () => '/repo/electron',
      electronVersion: () => '41.2.1',
      spawnElectronProbe: () => ({ code: 1, stdout: '', stderr: '', timedOut: true }),
      probePath: () => '/repo/scripts/native-runtime/probe.cjs'
    }
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    expect(report.failures.join('\n')).toContain('timed out')
    expect(report.failures.join('\n')).toContain('no retry')
  })
})
