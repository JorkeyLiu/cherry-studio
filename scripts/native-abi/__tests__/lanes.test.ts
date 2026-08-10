import { describe, expect, it } from 'vitest'

import {
  createLaneAdapter,
  ensureLane,
  type LaneAdapter,
  maybeRestoreElectron,
  restoreElectronLane,
  shouldRestoreElectron
} from '../lanes'
import type { LaneId } from '../lock'
import type { CheckReport, Effects, RebuildReport } from '../types'

// ---------------------------------------------------------------------------
// Scripted LaneAdapter fake: per-lane FIFO queues of check/rebuild reports, so
// stateful sequences (check fails, then passes after the rebuild) are
// deterministic. No real binding, subprocess, or I/O is involved.
// ---------------------------------------------------------------------------

class FakeAdapter implements LaneAdapter {
  checkQueue = new Map<LaneId, CheckReport[]>()
  rebuildQueue = new Map<LaneId, RebuildReport[]>()
  checkCalls: LaneId[] = []
  rebuildCalls: LaneId[] = []

  scriptCheck(lane: LaneId, ...reports: CheckReport[]): void {
    this.checkQueue.set(lane, [...reports])
  }

  scriptRebuild(lane: LaneId, ...reports: RebuildReport[]): void {
    this.rebuildQueue.set(lane, [...reports])
  }

  check(lane: LaneId): CheckReport {
    this.checkCalls.push(lane)
    const next = this.checkQueue.get(lane)?.shift()
    if (next === undefined) {
      throw new Error(`no scripted check for lane ${lane}`)
    }
    return next
  }

  async rebuild(lane: LaneId): Promise<RebuildReport> {
    this.rebuildCalls.push(lane)
    const next = this.rebuildQueue.get(lane)?.shift()
    if (next === undefined) {
      throw new Error(`no scripted rebuild for lane ${lane}`)
    }
    return next
  }
}

function checkReport(lane: LaneId, ok: boolean, failures: string[] = []): CheckReport {
  return {
    target: lane,
    ok,
    runtimeName: lane === 'node' ? 'node' : 'electron',
    runtimeVersion: lane === 'node' ? '24.11.1' : '41.2.1',
    abi: lane === 'node' ? 137 : 145,
    platform: 'darwin',
    arch: 'arm64',
    markerState: 'ignored',
    sqlVerified: ok,
    failures
  }
}

function rebuildReport(lane: LaneId, ok: boolean, failures: string[] = []): RebuildReport {
  return {
    target: lane,
    ok,
    nodeVersion: '24.11.1',
    abi: 137,
    platform: 'darwin',
    arch: 'arm64',
    markerBefore: [],
    toolOutput: [],
    failures
  }
}

describe('ensureLane (check, then rebuild + check only when needed)', () => {
  it('treats an already-valid target as a no-op: single check, no rebuild', async () => {
    const adapter = new FakeAdapter()
    const good = checkReport('node', true)
    adapter.scriptCheck('node', good)

    const result = await ensureLane(adapter, 'node')

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.lane).toBe('node')
      expect(result.rebuilt).toBe(false)
      // `rebuilt: false` structurally has no rebuild report (self-narrowing).
      expect(result.verify).toBe(good)
    }
    expect(adapter.checkCalls).toEqual(['node'])
    expect(adapter.rebuildCalls).toEqual([])
  })

  it('rebuilds only when the target check fails, then verifies with a fresh check', async () => {
    const adapter = new FakeAdapter()
    const bad = checkReport('node', false, ['no binding for node ABI 137'])
    const good = checkReport('node', true)
    const rebuilt = rebuildReport('node', true, [])
    adapter.scriptCheck('node', bad, good)
    adapter.scriptRebuild('node', rebuilt)

    const result = await ensureLane(adapter, 'node')

    expect(result.status).toBe('ok')
    if (result.status === 'ok' && result.rebuilt) {
      expect(result.rebuilt).toBe(true)
      expect(result.check).toBe(bad)
      expect(result.rebuild).toBe(rebuilt)
      expect(result.verify).toBe(good)
    }
    expect(adapter.checkCalls).toEqual(['node', 'node'])
    expect(adapter.rebuildCalls).toEqual(['node'])
  })

  it('returns rebuild-failed with the initial check and failed rebuild retained', async () => {
    const adapter = new FakeAdapter()
    const bad = checkReport('node', false, ['check: node ABI 137 missing'])
    const failed = rebuildReport('node', false, ['node-gyp exited with code 1', 'EACCES: permission denied'])
    adapter.scriptCheck('node', bad)
    adapter.scriptRebuild('node', failed)

    const result = await ensureLane(adapter, 'node')

    expect(result.status).toBe('rebuild-failed')
    if (result.status === 'rebuild-failed') {
      expect(result.check).toBe(bad)
      expect(result.rebuild).toBe(failed)
      // Diagnostics are retained verbatim.
      expect(result.check.failures).toEqual(['check: node ABI 137 missing'])
      expect(result.rebuild.failures).toEqual(['node-gyp exited with code 1', 'EACCES: permission denied'])
    }
    // The verify step is skipped: a failed rebuild ends the policy.
    expect(adapter.checkCalls).toEqual(['node'])
    expect(adapter.rebuildCalls).toEqual(['node'])
  })

  it('returns verify-failed when the post-rebuild check still fails', async () => {
    const adapter = new FakeAdapter()
    const bad = checkReport('electron', false, ['initial electron check failed'])
    const rebuilt = rebuildReport('electron', true, [])
    const stillBad = checkReport('electron', false, ['post-rebuild electron check failed'])
    adapter.scriptCheck('electron', bad, stillBad)
    adapter.scriptRebuild('electron', rebuilt)

    const result = await ensureLane(adapter, 'electron')

    expect(result.status).toBe('verify-failed')
    if (result.status === 'verify-failed') {
      expect(result.lane).toBe('electron')
      expect(result.check).toBe(bad)
      expect(result.rebuild).toBe(rebuilt)
      expect(result.verify).toBe(stillBad)
      expect(result.verify.failures).toEqual(['post-rebuild electron check failed'])
    }
    expect(adapter.checkCalls).toEqual(['electron', 'electron'])
    expect(adapter.rebuildCalls).toEqual(['electron'])
  })

  it('never runs a check for the opposite lane while ensuring one lane', async () => {
    const adapter = new FakeAdapter()
    adapter.scriptCheck('node', checkReport('node', true))

    const result = await ensureLane(adapter, 'node')

    expect(result.status).toBe('ok')
    expect(adapter.checkCalls).toEqual(['node'])
    expect(adapter.checkCalls).not.toContain('electron')
    expect(adapter.rebuildCalls).toEqual([])
  })
})

describe('restoreElectronLane (Electron ABI 145 restoration through the adapter)', () => {
  it('no-ops when Electron is already valid (no rebuild)', async () => {
    const adapter = new FakeAdapter()
    const ok = checkReport('electron', true)
    adapter.scriptCheck('electron', ok)

    const result = await restoreElectronLane(adapter)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.lane).toBe('electron')
      expect(result.rebuilt).toBe(false)
      // `rebuilt: false` structurally has no rebuild report (self-narrowing).
    }
    expect(adapter.checkCalls).toEqual(['electron'])
    expect(adapter.rebuildCalls).toEqual([])
  })

  it('rebuilds Electron and verifies when the restoration check fails', async () => {
    const adapter = new FakeAdapter()
    const bad = checkReport('electron', false, ['binding compiled for node ABI 137'])
    const good = checkReport('electron', true)
    adapter.scriptCheck('electron', bad, good)
    adapter.scriptRebuild('electron', rebuildReport('electron', true, []))

    const result = await restoreElectronLane(adapter)

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rebuilt).toBe(true)
      expect(result.check).toBe(bad)
      expect(result.verify).toBe(good)
    }
    expect(adapter.checkCalls).toEqual(['electron', 'electron'])
    expect(adapter.rebuildCalls).toEqual(['electron'])
  })

  it('retains the failed rebuild diagnostics on restoration failure', async () => {
    const adapter = new FakeAdapter()
    adapter.scriptCheck('electron', checkReport('electron', false, ['electron check failed']))
    adapter.scriptRebuild('electron', rebuildReport('electron', false, ['@electron/rebuild failed']))

    const result = await restoreElectronLane(adapter)

    expect(result.status).toBe('rebuild-failed')
    if (result.status === 'rebuild-failed') {
      expect(result.rebuild.failures).toEqual(['@electron/rebuild failed'])
    }
  })
})

describe('Electron restoration policy (LOCK-003: local Node lane, CI skips)', () => {
  it('shouldRestoreElectron is true only for a non-CI local Node lane', () => {
    expect(shouldRestoreElectron({ lane: 'node', ci: false })).toBe(true)
    expect(shouldRestoreElectron({ lane: 'node', ci: true })).toBe(false)
    expect(shouldRestoreElectron({ lane: 'electron', ci: false })).toBe(false)
    expect(shouldRestoreElectron({ lane: 'electron', ci: true })).toBe(false)
  })

  it('maybeRestoreElectron skips in CI without consulting the adapter', async () => {
    const adapter = new FakeAdapter()

    const result = await maybeRestoreElectron(adapter, { lane: 'node', ci: true })

    expect(result.status).toBe('skipped')
    if (result.status === 'skipped') {
      expect(result.reason).toBe('ci-skip')
    }
    expect(adapter.checkCalls).toEqual([])
    expect(adapter.rebuildCalls).toEqual([])
  })

  it('maybeRestoreElectron skips non-Node lanes without consulting the adapter', async () => {
    const adapter = new FakeAdapter()

    const result = await maybeRestoreElectron(adapter, { lane: 'electron', ci: false })

    expect(result.status).toBe('skipped')
    if (result.status === 'skipped') {
      expect(result.reason).toBe('non-node-lane')
    }
    expect(adapter.checkCalls).toEqual([])
    expect(adapter.rebuildCalls).toEqual([])
  })

  it('performs the Electron restore for a non-CI Node lane', async () => {
    const adapter = new FakeAdapter()
    adapter.scriptCheck('electron', checkReport('electron', true))

    const result = await maybeRestoreElectron(adapter, { lane: 'node', ci: false })

    expect(result.status).toBe('performed')
    if (result.status === 'performed') {
      expect(result.result.status).toBe('ok')
    }
    expect(adapter.checkCalls).toEqual(['electron'])
    expect(adapter.rebuildCalls).toEqual([])
  })
})

describe('createLaneAdapter (delegates to the existing runCheck / runRebuild)', () => {
  it('check delegates to the existing read-only runCheck', () => {
    // The stub cannot resolve the native package, so runCheck fails with its
    // standard diagnostic — proving delegation without touching a real binding.
    const adapter = createLaneAdapter(makeStubEffects())

    const report = adapter.check('node')

    expect(report.ok).toBe(false)
    expect(report.failures.join(' ')).toContain('not installed')
    expect(report.markerState).toBe('ignored')
  })

  it('rebuild delegates to the existing runRebuild', async () => {
    const adapter = createLaneAdapter(makeStubEffects())

    const report = await adapter.rebuild('node')

    expect(report.ok).toBe(false)
    expect(report.failures.join(' ')).toContain('not installed')
  })
})

// ---------------------------------------------------------------------------
// Minimal Effects stub satisfying every precondition the real runCheck /
// runRebuild touch before failing on package resolution. No native binding is
// loaded: the probe and rebuild backends are inert placeholders.
// ---------------------------------------------------------------------------

function makeStubEffects(overrides: Partial<Effects> = {}): Effects {
  return {
    runtimeInfo: () => ({
      runtime: 'node',
      nodeVersion: '24.11.1',
      modulesAbi: 137,
      platform: 'darwin',
      arch: 'arm64',
      execPath: '/usr/local/bin/node'
    }),
    readJson: () => ({ version: '12.11.1' }),
    readFile: () => undefined,
    realpath: (p) => p,
    exists: () => true,
    listDir: () => ({ ok: true, entries: [] }),
    removeFile: () => undefined,
    removeDir: () => undefined,
    resolvePackageJsonPath: () => undefined,
    resolveFilePath: () => undefined,
    probeNodeBinding: () => ({ ok: true, sqlOk: true }),
    electronBinPath: () => '/opt/Electron.app/Contents/MacOS/Electron',
    electronVersion: () => '41.2.1',
    spawnElectronProbe: () => ({ code: 0, stdout: '', stderr: '' }),
    pnpmVersion: () => '10.27.0',
    nodeGypJsPath: () => undefined,
    nodeDir: () => undefined,
    runNodeGyp: () => ({ code: 0, stdout: '', stderr: '' }),
    rebuildElectron: async () => ({ ok: true, logs: [] }),
    projectRoot: () => '/repo/checkout',
    probePath: () => '/repo/checkout/scripts/native-abi/probe.cjs',
    ...overrides
  }
}
