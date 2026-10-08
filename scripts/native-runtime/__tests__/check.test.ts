import { describe, expect, it } from 'vitest'

import { runElectronCheck, runNodeCheck, verifyPackageVersion } from '../check'
import { ELECTRON_ABI, ELECTRON_VERSION, NATIVE_PACKAGE_VERSION, NODE_ABI, NODE_MIN_VERSION } from '../constants'
import type { Effects, RuntimeInfo } from '../types'

/**
 * Focused regression coverage for the read-only runtime checks
 * (scripts/native-runtime/check.ts):
 *
 *  - locked dependency version failures carry dependency remediation and never
 *    suggest a rebuild, relink, or lock operation;
 *  - SQL probe failures fail closed with the probe error preserved;
 *  - observed ABI numbers are informational only and never gate success;
 *  - checks perform no rebuild, no locking, and no writes (the fake Effects
 *    records every call; the checks must only read).
 */

const BASE_RUNTIME: RuntimeInfo = {
  runtime: 'node',
  nodeVersion: '24.11.1',
  modulesAbi: NODE_ABI,
  platform: 'darwin',
  arch: 'arm64',
  execPath: '/repo/node'
}

interface CallLog {
  readJson: string[]
  realpath: string[]
  exists: string[]
  spawnedElectronProbes: number
  nodeProbes: number
}

function createFakeEffects(overrides: {
  runtime?: RuntimeInfo
  packageVersion?: string
  nodeProbe?: { ok: boolean; sqlOk: boolean; error?: string; closeError?: string }
  electronProbeJson?: string
  electronProbeCode?: number
  electronVersion?: string
  /** `null` simulates a missing Electron binary; `undefined` uses the default. */
  electronBin?: string | null
}): { effects: Effects; log: CallLog } {
  const log: CallLog = { readJson: [], realpath: [], exists: [], spawnedElectronProbes: 0, nodeProbes: 0 }
  const effects: Effects = {
    runtimeInfo: () => overrides.runtime ?? BASE_RUNTIME,
    readJson: (p) => {
      log.readJson.push(p)
      return { version: overrides.packageVersion ?? NATIVE_PACKAGE_VERSION }
    },
    realpath: (p) => {
      log.realpath.push(p)
      return `/real${p}`
    },
    exists: (p) => {
      log.exists.push(p)
      return true
    },
    resolvePackageJsonPath: () => '/repo/node_modules/better-sqlite3/package.json',
    probeNodeBinding: () => {
      log.nodeProbes += 1
      return overrides.nodeProbe ?? { ok: true, sqlOk: true }
    },
    electronBinPath: () =>
      overrides.electronBin === undefined ? '/repo/electron' : (overrides.electronBin ?? undefined),
    electronVersion: () => overrides.electronVersion ?? ELECTRON_VERSION,
    spawnElectronProbe: () => {
      log.spawnedElectronProbes += 1
      const json =
        overrides.electronProbeJson ??
        JSON.stringify({
          ok: true,
          runtime: 'electron',
          version: ELECTRON_VERSION,
          nodeVersion: '24.14.1',
          abi: ELECTRON_ABI,
          platform: 'darwin',
          arch: 'arm64',
          sqlOk: true
        })
      return { code: overrides.electronProbeCode ?? 0, stdout: `NATIVE_RUNTIME_PROBE_V1 ${json}\n`, stderr: '' }
    },
    probePath: () => '/repo/scripts/native-runtime/probe.cjs'
  }
  return { effects, log }
}

describe('verifyPackageVersion', () => {
  it('passes on the locked version', () => {
    const { effects } = createFakeEffects({})
    expect(verifyPackageVersion(effects, '/real/pkg')).toBeUndefined()
  })

  it('fails with dependency remediation and never references rebuild machinery', () => {
    const { effects } = createFakeEffects({ packageVersion: '12.11.1' })
    const failure = verifyPackageVersion(effects, '/real/pkg')
    expect(failure).toBeDefined()
    expect(failure).toContain('12.11.1')
    expect(failure).toContain(NATIVE_PACKAGE_VERSION)
    expect(failure).toContain('pnpm install')
    // No rebuild machinery references (bare "prebuilds" is the Node-API
    // artifact noun, not a rebuild action).
    expect(failure).not.toMatch(/native:rebuild/)
    expect(failure).not.toMatch(/@electron\/rebuild/)
    expect(failure).not.toMatch(/node-gyp/)
    expect(failure).not.toMatch(/\.native-abi-lock/)
  })
})

describe('runNodeCheck', () => {
  it('passes on a supported runtime with a passing SQL probe', () => {
    const { effects } = createFakeEffects({})
    const report = runNodeCheck(effects)
    expect(report.ok).toBe(true)
    expect(report.sqlVerified).toBe(true)
    expect(report.failures).toEqual([])
  })

  it('fails closed on an unsupported Node version', () => {
    const { effects } = createFakeEffects({
      runtime: { ...BASE_RUNTIME, nodeVersion: '22.0.0', modulesAbi: 127 }
    })
    const report = runNodeCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    expect(report.failures.join('\n')).toContain(NODE_MIN_VERSION)
    expect(report.failures.join('\n')).not.toMatch(/native:rebuild/)
  })

  it('does NOT gate on the observed ABI number (informational only)', () => {
    // A Node with an unexpected modules ABI but a passing SQL probe still
    // passes: the Node-API binary is runtime-agnostic.
    const { effects, log } = createFakeEffects({
      runtime: { ...BASE_RUNTIME, modulesAbi: 999 }
    })
    const report = runNodeCheck(effects)
    expect(report.ok).toBe(true)
    expect(report.abi).toBe(999)
    expect(log.nodeProbes).toBe(1)
  })

  it('fails closed when the SQL probe fails and preserves the probe error', () => {
    const { effects } = createFakeEffects({
      nodeProbe: { ok: false, sqlOk: false, error: 'Cannot load native module' }
    })
    const report = runNodeCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    expect(report.failures.join('\n')).toContain('Cannot load native module')
    expect(report.failures.join('\n')).toContain('pnpm install')
    expect(report.failures.join('\n')).not.toMatch(/native:rebuild/)
    expect(report.failures.join('\n')).not.toMatch(/node-gyp/)
  })

  it('surfaces a probe close error alongside the primary error', () => {
    const { effects } = createFakeEffects({
      nodeProbe: { ok: false, sqlOk: false, error: 'boom', closeError: 'close boom' }
    })
    const report = runNodeCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.probeCloseError).toBe('close boom')
    expect(report.failures.join('\n')).toContain('close boom')
  })

  it('performs no writes: only readJson/realpath/resolve/probe are used', () => {
    const { effects, log } = createFakeEffects({})
    runNodeCheck(effects)
    expect(log.readJson.length).toBeGreaterThan(0)
    expect(log.realpath.length).toBeGreaterThan(0)
    expect(log.spawnedElectronProbes).toBe(0)
    // The Effects seam exposes no write operation at all (compile-time), and
    // the check never spawns a rebuild or touches a lockfile: the fake has no
    // such method to record.
  })
})

describe('runElectronCheck', () => {
  it('passes with a passing Electron SQL probe', () => {
    const { effects } = createFakeEffects({})
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(true)
    expect(report.sqlVerified).toBe(true)
    expect(report.runtimeVersion).toBe(ELECTRON_VERSION)
    expect(report.abi).toBe(ELECTRON_ABI)
  })

  it('fails closed on unsupported host platforms', () => {
    const { effects } = createFakeEffects({
      runtime: { ...BASE_RUNTIME, platform: 'linux', arch: 'x64' }
    })
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('darwin arm64 or win32 x64')
  })

  it('fails closed when the installed Electron version mismatches', () => {
    const { effects } = createFakeEffects({ electronVersion: '42.0.0' })
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('42.0.0')
    expect(report.failures.join('\n')).toContain(ELECTRON_VERSION)
  })

  it('fails closed when the Electron binary is missing', () => {
    const { effects } = createFakeEffects({ electronBin: null })
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('pnpm install')
  })

  it('fails closed when the Electron SQL probe fails', () => {
    const { effects } = createFakeEffects({
      electronProbeJson: JSON.stringify({
        ok: false,
        runtime: 'electron',
        version: ELECTRON_VERSION,
        nodeVersion: '24.14.1',
        abi: ELECTRON_ABI,
        platform: 'darwin',
        arch: 'arm64',
        sqlOk: false,
        error: 'probe boom'
      }),
      electronProbeCode: 1
    })
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    expect(report.failures.join('\n')).toContain('probe boom')
    expect(report.failures.join('\n')).not.toMatch(/native:rebuild/)
    expect(report.failures.join('\n')).not.toMatch(/node-gyp/)
  })

  it('fails closed when the probe runtime version mismatches', () => {
    const { effects } = createFakeEffects({
      electronProbeJson: JSON.stringify({
        ok: true,
        runtime: 'electron',
        version: '99.0.0',
        nodeVersion: '24.14.1',
        abi: ELECTRON_ABI,
        platform: 'darwin',
        arch: 'arm64',
        sqlOk: true
      })
    })
    const report = runElectronCheck(effects)
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('99.0.0')
  })
})
