import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { bindingCandidatePaths, removeMarkers, removeStaleBinDirs } from '../binding'
import { parseProbeOutput, runCheck, runElectronCheck, runNodeCheck } from '../check'
import {
  ELECTRON_ABI,
  ELECTRON_VERSION,
  NATIVE_PACKAGE_VERSION,
  NODE_ABI,
  NODE_MIN_VERSION,
  PROBE_MARKER,
  PROBE_MARKER_ENV,
  PROBE_MODULE_ENV,
  PROBE_TEST_SEAM_ENV
} from '../constants'
import { createEffects, sanitizeNodeGypEnv } from '../effects'
import { runRebuild } from '../rebuild'
import { formatCheckReport } from '../report'
import type {
  CheckReport,
  DirListing,
  Effects,
  ElectronProbeOutput,
  ElectronRebuildApiOptions,
  NodeGypRunOptions,
  ProbeResult,
  RebuildRunResult,
  RuntimeInfo,
  SpawnResult
} from '../types'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_PATH = path.join(HERE, '..', 'probe.cjs')
const REPO_ROOT = path.join(HERE, '..', '..', '..')

// ---------------------------------------------------------------------------
// Faithful in-memory filesystem + Effects fake. The command logic only sees
// this seam, so all ten required behaviors are covered deterministically
// without ever touching the real binding (which stays ABI 145).
// ---------------------------------------------------------------------------

class Vfs {
  files = new Map<string, string>()
  dirs = new Set<string>()
  removedFiles = new Set<string>()
  removedDirs = new Set<string>()

  constructor() {
    this.mkdirp(path.sep)
  }

  mkdirp(p: string): void {
    let cur = p
    const parts: string[] = []
    while (cur !== path.dirname(cur)) {
      parts.push(cur)
      cur = path.dirname(cur)
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      this.dirs.add(parts[i])
    }
  }

  addFile(p: string, content: string): void {
    this.files.set(p, content)
    this.mkdirp(path.dirname(p))
  }

  exists(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p)
  }

  readFile(p: string): string | undefined {
    return this.files.get(p)
  }

  listDir(p: string): string[] {
    if (!this.dirs.has(p)) {
      return []
    }
    const out = new Set<string>()
    for (const f of this.files.keys()) {
      if (path.dirname(f) === p) {
        out.add(path.basename(f))
      }
    }
    for (const d of this.dirs) {
      if (path.dirname(d) === p) {
        out.add(path.basename(d))
      }
    }
    return [...out]
  }

  removeFile(p: string): void {
    if (this.files.delete(p)) {
      this.removedFiles.add(p)
    }
  }

  removeDir(p: string): void {
    if (this.dirs.delete(p)) {
      this.removedDirs.add(p)
    }
    for (const f of [...this.files.keys()]) {
      if (f.startsWith(p + path.sep)) {
        this.files.delete(f)
      }
    }
  }
}

/** Sentinel: FakeEffects.nodeDir returns undefined (local headers not proven). */
const NO_NODE_DIR = '\u0000no-node-dir\u0000'

const PKG_SYMLINK = path.join(path.sep, 'repo', 'node_modules', 'better-sqlite3', 'package.json')
const PKG_REAL = path.join(
  path.sep,
  'repo',
  'node_modules',
  '.pnpm',
  'better-sqlite3@12.11.1',
  'node_modules',
  'better-sqlite3'
)
const BINDING_RELEASE = path.join(PKG_REAL, 'build', 'Release', 'better_sqlite3.node')
const MARKER_RELEASE = path.join(PKG_REAL, 'build', 'Release', '.forge-meta')

interface FakeOptions {
  nodeVersion?: string
  modulesAbi?: number
  platform?: string
  arch?: string
  execPath?: string
  probeNode?: ProbeResult
  electronVersion?: string
  electronBin?: string
  electronProbe?: SpawnResult
  pnpmVersion?: string
  nodeGypJs?: string
  nodeGypResult?: SpawnResult
  /** Override the derived nodeDir. NO_NODE_DIR sentinel = headers not proven. */
  nodeDirValue?: string
  rebuildElectronResult?: RebuildRunResult
  /** When set, removeFile returns this error instead of removing (finding C). */
  removeFileError?: string
  /** When set, removeDir returns this error instead of removing (finding C). */
  removeDirError?: string
  /** When set, listDir fails with this error for every directory (finding H). */
  listDirError?: string
  /** Callback invoked by probeNodeBinding — enables stateful ordering tests. */
  onProbeNode?: () => ProbeResult
  /** Callback invoked by spawnElectronProbe — enables stateful ordering tests. */
  onElectronProbe?: () => SpawnResult
  /** Callback invoked by runNodeGyp — enables stateful ordering tests. */
  onRunNodeGyp?: () => SpawnResult
  /** Callback invoked by rebuildElectron — enables stateful ordering tests. */
  onRebuildElectron?: () => RebuildRunResult | Promise<RebuildRunResult>
}

class FakeEffects implements Effects {
  vfs = new Vfs()
  calls: string[] = []
  /** Last option object passed to runNodeGyp (finding G: full NodeGyp args). */
  nodeGypOpts?: NodeGypRunOptions
  /** Last option object passed to rebuildElectron (finding G: full options). */
  electronRebuildOpts?: ElectronRebuildApiOptions
  /** Last boundary passed to removeFile (safe-removal call contract). */
  lastRemoveFileBoundary?: string
  /** Last boundary passed to removeDir (safe-removal call contract). */
  lastRemoveDirBoundary?: string

  nodeVersion: string
  modulesAbi: number
  platform: string
  arch: string
  execPath: string

  probeNode: ProbeResult | undefined
  onProbeNode: (() => ProbeResult) | undefined
  electronVersionValue: string | undefined
  electronBin: string | undefined
  electronProbe: SpawnResult | undefined
  onElectronProbe: (() => SpawnResult) | undefined
  pnpmVersionValue: string | undefined
  nodeGypJs: string | undefined
  nodeGypResult: SpawnResult | undefined
  onRunNodeGyp: (() => SpawnResult) | undefined
  nodeDirValue: string | undefined
  rebuildElectronResult: RebuildRunResult | undefined
  onRebuildElectron: (() => RebuildRunResult | Promise<RebuildRunResult>) | undefined
  removeFileError: string | undefined
  removeDirError: string | undefined
  listDirError: string | undefined

  constructor(opts: FakeOptions = {}) {
    this.nodeVersion = opts.nodeVersion ?? '24.12.0'
    this.modulesAbi = opts.modulesAbi ?? NODE_ABI
    this.platform = opts.platform ?? 'darwin'
    this.arch = opts.arch ?? 'arm64'
    this.execPath = opts.execPath ?? path.join(path.sep, 'node24', 'bin', 'node')
    this.probeNode = opts.probeNode
    this.onProbeNode = opts.onProbeNode
    this.electronVersionValue = opts.electronVersion
    this.electronBin = opts.electronBin
    this.electronProbe = opts.electronProbe
    this.onElectronProbe = opts.onElectronProbe
    this.pnpmVersionValue = opts.pnpmVersion
    this.nodeGypJs = opts.nodeGypJs
    this.nodeGypResult = opts.nodeGypResult
    this.onRunNodeGyp = opts.onRunNodeGyp
    this.nodeDirValue = opts.nodeDirValue === undefined ? path.join(path.sep, 'node24') : opts.nodeDirValue
    this.rebuildElectronResult = opts.rebuildElectronResult
    this.onRebuildElectron = opts.onRebuildElectron
    this.removeFileError = opts.removeFileError
    this.removeDirError = opts.removeDirError
    this.listDirError = opts.listDirError

    // Default installed layout: package present, Electron present, execPath file present.
    this.vfs.addFile(this.execPath, 'node-binary')
    this.vfs.addFile(PKG_SYMLINK, JSON.stringify({ name: 'better-sqlite3', version: '12.11.1' }))
    this.vfs.addFile(
      path.join(PKG_REAL, 'package.json'),
      JSON.stringify({ name: 'better-sqlite3', version: NATIVE_PACKAGE_VERSION })
    )
  }

  /** Simulate the pnpm symlink → realpath resolution (LOCK-ABI-5). */
  addPackageBinding(opts: { exists?: boolean; marker?: string; electronBin?: boolean } = {}): void {
    if (opts.exists ?? true) {
      this.vfs.addFile(BINDING_RELEASE, 'fake-binding-bytes')
    }
    if (opts.marker) {
      this.vfs.addFile(MARKER_RELEASE, opts.marker)
    }
    if (opts.electronBin ?? true) {
      this.vfs.mkdirp(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))
    }
  }

  record = (call: string): void => {
    this.calls.push(call)
  }

  runtimeInfo = (): RuntimeInfo => {
    return {
      runtime: 'node',
      nodeVersion: this.nodeVersion,
      modulesAbi: this.modulesAbi,
      platform: this.platform,
      arch: this.arch,
      execPath: this.execPath
    }
  }

  readJson = (p: string): unknown => {
    const raw = this.vfs.readFile(p)
    if (raw === undefined) {
      throw new Error(`readJson: no such file ${p}`)
    }
    return JSON.parse(raw) as unknown
  }

  readFile = (p: string): string | undefined => {
    return this.vfs.readFile(p)
  }

  realpath = (p: string): string => {
    this.record(`realpath:${p}`)
    return p === path.dirname(PKG_SYMLINK) ? PKG_REAL : p
  }

  exists = (p: string): boolean => {
    return this.vfs.exists(p)
  }

  listDir = (p: string): DirListing => {
    if (this.listDirError) {
      return { ok: false, error: `listDir(${p}): ${this.listDirError}` }
    }
    return { ok: true, entries: this.vfs.listDir(p) }
  }

  removeFile = (p: string, boundary?: string): string | undefined => {
    this.record(`removeFile:${p}`)
    this.lastRemoveFileBoundary = boundary
    if (this.removeFileError) {
      return this.removeFileError
    }
    this.vfs.removeFile(p)
    return undefined
  }

  removeDir = (p: string, boundary?: string): string | undefined => {
    this.record(`removeDir:${p}`)
    this.lastRemoveDirBoundary = boundary
    if (this.removeDirError) {
      return this.removeDirError
    }
    this.vfs.removeDir(p)
    return undefined
  }

  resolvePackageJsonPath = (pkg: string): string | undefined => {
    if (pkg === 'better-sqlite3') {
      return PKG_SYMLINK
    }
    return undefined
  }

  resolveFilePath = (spec: string): string | undefined => {
    // require.resolve semantics: absolute paths resolve if the file exists.
    return this.vfs.exists(spec) ? spec : undefined
  }

  probeNodeBinding = (): ProbeResult => {
    this.record('probeNode')
    if (this.onProbeNode) {
      return this.onProbeNode()
    }
    return this.probeNode ?? { ok: false, sqlOk: false, error: 'fake probe not configured' }
  }

  electronBinPath = (): string | undefined => {
    return this.electronBin ?? path.join(path.sep, 'repo', 'node_modules', 'electron', 'dist', 'Electron')
  }

  electronVersion = (): string | undefined => {
    return this.electronVersionValue ?? ELECTRON_VERSION
  }

  spawnElectronProbe = (bin: string, probePath: string): SpawnResult => {
    this.record(`spawnElectronProbe:${bin} ${probePath}`)
    if (this.onElectronProbe) {
      return this.onElectronProbe()
    }
    return this.electronProbe ?? { code: 1, stdout: '', stderr: 'fake probe not configured' }
  }

  pnpmVersion = (): string | undefined => {
    return this.pnpmVersionValue ?? '10.27.0'
  }

  nodeGypJsPath = (): string | undefined => {
    return this.nodeGypJs ?? path.join(path.sep, 'repo', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  }

  nodeDir = (_execPath: string): string | undefined => {
    void _execPath
    // NO_NODE_DIR sentinel exercises the missing-local-headers precondition.
    return this.nodeDirValue === NO_NODE_DIR ? undefined : this.nodeDirValue
  }

  runNodeGyp = (opts: NodeGypRunOptions): SpawnResult => {
    this.nodeGypOpts = opts
    this.record('runNodeGyp')
    if (this.onRunNodeGyp) {
      return this.onRunNodeGyp()
    }
    return this.nodeGypResult ?? { code: 0, stdout: 'gyp ok', stderr: '' }
  }

  rebuildElectron = async (opts: ElectronRebuildApiOptions): Promise<RebuildRunResult> => {
    this.electronRebuildOpts = opts
    this.record('rebuildElectron')
    if (this.onRebuildElectron) {
      return await this.onRebuildElectron()
    }
    return this.rebuildElectronResult ?? { ok: true, logs: ['rebuild ok'] }
  }

  projectRoot = (): string => {
    return path.join(path.sep, 'repo')
  }

  probePath = (): string => {
    return path.join(path.sep, 'repo', 'scripts', 'native-abi', 'probe.cjs')
  }
}

function probeStdout(partial: Partial<ElectronProbeOutput>): SpawnResult {
  const record: ElectronProbeOutput = {
    ok: true,
    runtime: 'electron',
    version: ELECTRON_VERSION,
    nodeVersion: '24.14.1',
    abi: ELECTRON_ABI,
    platform: 'darwin',
    arch: 'arm64',
    sqlOk: true,
    ...partial
  }
  return { code: record.ok && record.sqlOk ? 0 : 1, stdout: `${PROBE_MARKER} ${JSON.stringify(record)}\n`, stderr: '' }
}

const okProbe: ProbeResult = { ok: true, sqlOk: true }

function nodeFailures(report: CheckReport): string[] {
  return report.failures
}

// ---------------------------------------------------------------------------

describe('native-abi binding candidates', () => {
  it('build/Release is preferred over bin/ (mirrors the bindings try-order)', () => {
    const candidates = bindingCandidatePaths({
      packagePath: PKG_REAL,
      nodeRuntimeVersion: '24.12.0',
      platform: 'darwin',
      arch: 'arm64',
      abi: NODE_ABI
    })
    expect(candidates[0]).toBe(path.join(PKG_REAL, 'build', 'better_sqlite3.node'))
    expect(candidates[2]).toBe(BINDING_RELEASE)
    // The @electron/rebuild bin/ copy is not in the bindings search order.
    expect(candidates.some((c) => c.includes(path.join('bin', 'darwin-arm64')))).toBe(false)
  })

  it('compiled/<version>/<platform>/<arch> uses the target runtime Node version, never the package version', () => {
    const candidates = bindingCandidatePaths({
      packagePath: PKG_REAL,
      nodeRuntimeVersion: '24.14.1',
      platform: 'darwin',
      arch: 'arm64',
      abi: ELECTRON_ABI
    })
    expect(candidates).toContain(path.join(PKG_REAL, 'compiled', '24.14.1', 'darwin', 'arm64', 'better_sqlite3.node'))
    // `bindings` reads process.versions.node of the target runtime (finding B).
    expect(candidates.some((c) => c.includes(path.join('compiled', NATIVE_PACKAGE_VERSION)))).toBe(false)
    expect(candidates.some((c) => c.includes(path.join('compiled', '12.11.1')))).toBe(false)
  })
})

describe('parseProbeOutput', () => {
  it('extracts the JSON from the marker line, ignoring noise', () => {
    const out = `random noise\n${PROBE_MARKER} {"ok":true,"runtime":"electron","version":"41.2.1","abi":145,"sqlOk":true}\n`
    const parsed = parseProbeOutput(out)
    expect(parsed?.ok).toBe(true)
    expect(parsed?.abi).toBe(145)
  })

  it('returns undefined when the marker is absent', () => {
    expect(parseProbeOutput('no marker here')).toBeUndefined()
  })
})

describe('native:check:node', () => {
  it('PASSES on a supported Node24 with a working ABI137 binding (real SQL probe)', () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding()
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(true)
    expect(report.sqlVerified).toBe(true)
    expect(report.runtimeVersion).toBe('24.12.0')
    expect(report.abi).toBe(NODE_ABI)
    expect(report.packagePath).toBe(PKG_REAL)
    expect(report.bindingPath).toBe(BINDING_RELEASE)
    expect(report.markerState).toBe('ignored')
    expect(fake.calls).toContain('probeNode')
  })

  it('FAILS when the binding is the Electron145 build and emits the Node repair command', () => {
    const fake = new FakeEffects({
      probeNode: {
        ok: false,
        sqlOk: false,
        error:
          "The module '.../better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 145. This version of Node.js requires NODE_MODULE_VERSION 137."
      }
    })
    fake.addPackageBinding()
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    const failures = nodeFailures(report).join('\n')
    expect(failures).toContain('pnpm native:rebuild:node')
  })

  it('FAILS clearly on an unsupported Node runtime (Node22 / ABI 127) with the repair command', () => {
    const fake = new FakeEffects({ nodeVersion: '22.23.1', modulesAbi: 127, probeNode: okProbe })
    fake.addPackageBinding()
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(false)
    const failures = nodeFailures(report).join('\n')
    expect(failures).toContain(NODE_MIN_VERSION)
    expect(failures).toContain('pnpm native:rebuild:node')
  })

  it('FAILS when the binding file exists but the runtime SQL probe does not pass (markers/filenames prove nothing)', () => {
    // The file is on disk but loading it at runtime fails — check must FAIL.
    const fake = new FakeEffects({
      probeNode: { ok: false, sqlOk: false, error: 'dlopen failed: ABI mismatch' }
    })
    fake.addPackageBinding()
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    expect(report.bindingPath).toBe(BINDING_RELEASE)
  })

  it('surfaces a Node probe close error alongside the primary probe error (finding H)', () => {
    const fake = new FakeEffects({
      probeNode: { ok: false, sqlOk: false, error: 'prepare boom', closeError: 'close boom' }
    })
    fake.addPackageBinding()
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    // Primary error preserved first, close error surfaced as its own line.
    expect(failures.indexOf('prepare boom')).toBeGreaterThanOrEqual(0)
    expect(failures).toContain('Node probe close error: close boom')
    expect(report.probeCloseError).toBe('close boom')
  })

  it('reports the pnpm package realpath (symlink resolved), not the node_modules symlink', () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding()
    const report = runNodeCheck(fake)
    expect(report.packagePath).toBe(PKG_REAL)
    expect(report.packagePath?.startsWith('.pnpm')).toBe(false)
    expect(report.packagePath).toContain('.pnpm')
  })

  it('ignores a stale marker claiming Electron success: outcome is decided by the probe alone', () => {
    // Marker says arm64--145 but the binding is actually a broken/electron build.
    const staleMarker = new FakeEffects({
      probeNode: { ok: false, sqlOk: false, error: 'NODE_MODULE_VERSION 145 mismatch' }
    })
    staleMarker.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const staleReport = runNodeCheck(staleMarker)
    expect(staleReport.ok).toBe(false)

    // A stale marker must not break a working binding either.
    const good = new FakeEffects({ probeNode: okProbe })
    good.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const goodReport = runNodeCheck(good)
    expect(goodReport.ok).toBe(true)

    // And the check itself never touches the marker or any file.
    expect(staleMarker.vfs.removedFiles.size).toBe(0)
    expect(staleMarker.vfs.removedDirs.size).toBe(0)
  })

  it('is read-only: a passing check performs no filesystem mutations', () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const before = fake.vfs.files.size
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(true)
    expect(fake.vfs.files.size).toBe(before)
    expect(fake.vfs.removedFiles.size).toBe(0)
    expect(fake.vfs.removedDirs.size).toBe(0)
    expect(fake.calls.some((c) => c.startsWith('remove'))).toBe(false)
  })
})

describe('native:check:electron', () => {
  it('PASSES on Electron 41.2.1 with a working ABI145 binding (real probe via ELECTRON_RUN_AS_NODE)', () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(true)
    expect(report.sqlVerified).toBe(true)
    expect(report.runtimeName).toBe('electron')
    expect(report.runtimeVersion).toBe(ELECTRON_VERSION)
    expect(report.abi).toBe(ELECTRON_ABI)
    expect(report.bindingPath).toBe(BINDING_RELEASE)
    expect(fake.calls.some((c) => c.startsWith('spawnElectronProbe'))).toBe(true)
  })

  it('FAILS when the binding is the Node137 build and emits the Electron repair command', () => {
    const probe = probeStdout({
      ok: false,
      abi: NODE_ABI,
      sqlOk: false,
      error: "The module '.../better_sqlite3.node' was compiled against NODE_MODULE_VERSION 137. Electron requires 145."
    })
    const fake = new FakeEffects({ electronProbe: probe })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
    expect(report.abi).toBe(NODE_ABI)
    const failures = nodeFailures(report).join('\n')
    expect(failures).toContain('pnpm native:rebuild:electron')
  })

  it('preserves child stdout/stderr and exit code in the failure report', () => {
    const fake = new FakeEffects({
      electronProbe: {
        code: 7,
        stdout: `${PROBE_MARKER} {"ok":false,"sqlOk":false,"error":"boom"}\n`,
        stderr: 'trace line'
      }
    })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    const failures = nodeFailures(report).join('\n')
    expect(failures).toContain('boom')
    expect(failures).toContain('trace line')
  })

  it('surfaces the Electron child exit code and probe close error explicitly (finding H)', () => {
    const fake = new FakeEffects({
      electronProbe: {
        code: 7,
        stdout: `${PROBE_MARKER} ${JSON.stringify({
          ok: false,
          runtime: 'electron',
          version: ELECTRON_VERSION,
          nodeVersion: '24.14.1',
          abi: ELECTRON_ABI,
          platform: 'darwin',
          arch: 'arm64',
          sqlOk: false,
          error: 'dlopen failed',
          closeError: 'close boom'
        })}\n`,
        stderr: ''
      }
    })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    const failures = nodeFailures(report).join('\n')
    expect(failures).toContain('dlopen failed')
    expect(failures).toContain('Probe exit code: 7')
    expect(failures).toContain('Electron probe close error: close boom')
    expect(report.probeExitCode).toBe(7)
    expect(report.probeCloseError).toBe('close boom')
  })

  it('FAILS on unsupported platform/arch (e.g. linux/x64) for the Electron target', () => {
    const fake = new FakeEffects({ platform: 'linux', arch: 'x64', electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    expect(nodeFailures(report).join('\n')).toContain('darwin arm64')
  })

  it('FAILS when the installed Electron version differs from the locked 41.2.1', () => {
    const fake = new FakeEffects({ electronVersion: '42.0.0', electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    expect(nodeFailures(report).join('\n')).toContain(ELECTRON_VERSION)
  })

  it('FAILS when the probe SQL is false even though the probe exited 0', () => {
    const probe = probeStdout({ sqlOk: false })
    const fake = new FakeEffects({ electronProbe: probe })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    expect(report.sqlVerified).toBe(false)
  })

  it('is read-only on success', () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({}) })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(true)
    expect(fake.vfs.removedFiles.size).toBe(0)
    expect(fake.vfs.removedDirs.size).toBe(0)
  })
})

describe('native:rebuild preconditions', () => {
  it('refuses to rebuild under an unsupported Node runtime', async () => {
    const fake = new FakeEffects({ nodeVersion: '22.23.1', modulesAbi: 127, probeNode: okProbe })
    fake.addPackageBinding()
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain(NODE_MIN_VERSION)
  })

  it('refuses to rebuild when pnpm version differs from the locked 10.27.0', async () => {
    const fake = new FakeEffects({ probeNode: okProbe, pnpmVersion: '9.0.0' })
    fake.addPackageBinding()
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('10.27.0')
  })

  it('captures the marker state before the rebuild and reports it', async () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'node')
    expect(report.markerBefore).toHaveLength(1)
    expect(report.markerBefore[0].content).toBe(`arm64--${ELECTRON_ABI}`)
  })

  it('refuses the Node rebuild when local headers cannot be proven (fail-before-child, LOCK-ABI-5/7)', async () => {
    const fake = new FakeEffects({ probeNode: okProbe, nodeDirValue: NO_NODE_DIR })
    fake.addPackageBinding()
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    expect(failures).toContain('Local Node24 headers not found')
    expect(failures).toContain('include/node/node.h')
    expect(failures).toContain('No fallback to downloaded headers or inherited npm_config_nodedir')
    // Fail-before-child: node-gyp never spawned; no success marker claimed.
    expect(fake.calls).not.toContain('runNodeGyp')
    expect(report.markerBefore).toBeDefined()
  })
})

describe('native:rebuild failure behavior (LOCK-ABI-6)', () => {
  it('Node rebuild failure reports no success and removes any marker that could claim success', async () => {
    const fake = new FakeEffects({
      probeNode: okProbe,
      nodeGypResult: { code: 1, stdout: 'gyp ERR! build error', stderr: 'stack' }
    })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('node-gyp exited with code 1')
    expect(fake.vfs.exists(MARKER_RELEASE)).toBe(false)
  })

  it('Electron rebuild API failure reports no success and removes the marker', async () => {
    const fake = new FakeEffects({
      probeNode: okProbe,
      rebuildElectronResult: { ok: false, logs: ['gyp ERR!'], error: 'node-gyp failed to rebuild' }
    })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'electron')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('node-gyp failed to rebuild')
    expect(fake.vfs.exists(MARKER_RELEASE)).toBe(false)
  })

  it('a failed post-rebuild check invalidates the marker (no misleading success)', async () => {
    const fake = new FakeEffects({
      // node-gyp "succeeds" but the runtime probe still fails.
      probeNode: { ok: false, sqlOk: false, error: 'still broken after build' },
      nodeGypResult: { code: 0, stdout: 'gyp ok', stderr: '' }
    })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    expect(report.postCheck).toBeDefined()
    expect(report.postCheck?.ok).toBe(false)
    expect(fake.vfs.exists(MARKER_RELEASE)).toBe(false)
  })
})

describe('native:rebuild success behavior', () => {
  it('Node rebuild success runs the post-check, removes stale markers and stale Electron bin copies', async () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    fake.vfs.mkdirp(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(true)
    expect(report.postCheck?.ok).toBe(true)
    expect(fake.vfs.exists(MARKER_RELEASE)).toBe(false)
    expect(fake.vfs.exists(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))).toBe(false)
    expect(fake.calls).toContain('runNodeGyp')
  })

  it('Electron rebuild success runs the post-check and may leave the tool-written marker (non-authoritative)', async () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({}) })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'electron')
    expect(report.ok).toBe(true)
    expect(report.postCheck?.ok).toBe(true)
    // LOCK-ABI-6: a successful Electron rebuild may leave the tool-written marker.
    expect(fake.vfs.exists(MARKER_RELEASE)).toBe(true)
    expect(fake.calls).toContain('rebuildElectron')
  })
})

describe('explicit Node→Electron→Node ordering with faithful stateful fakes', () => {
  it('requires explicit rebuilds between runtime switches and always verifies with real SQL', async () => {
    // Faithful state machine: the single binding is EITHER ABI137 (Node) or
    // ABI145 (Electron), exactly like the real pnpm package on disk.
    let currentAbi: number = ELECTRON_ABI // starts as the current Electron build
    const fake = new FakeEffects({
      onProbeNode: () => {
        if (currentAbi === NODE_ABI) {
          return { ok: true, sqlOk: true }
        }
        return {
          ok: false,
          sqlOk: false,
          error: `binding ABI ${currentAbi} != Node ABI ${NODE_ABI}`
        }
      },
      onElectronProbe: () =>
        probeStdout({
          abi: currentAbi,
          sqlOk: currentAbi === ELECTRON_ABI,
          ok: currentAbi === ELECTRON_ABI
        }),
      onRunNodeGyp: () => {
        currentAbi = NODE_ABI
        return { code: 0, stdout: 'gyp ok', stderr: '' }
      },
      onRebuildElectron: async () => {
        currentAbi = ELECTRON_ABI
        return { ok: true, logs: ['rebuild ok'] }
      }
    })
    fake.addPackageBinding()

    // 1. Node check against the Electron binding -> FAIL with repair command.
    const checkNode1 = runCheck(fake, 'node')
    expect(checkNode1.ok).toBe(false)
    expect(checkNode1.failures.join('\n')).toContain('pnpm native:rebuild:node')

    // 2. Explicit Node rebuild -> post-check PASSES, binding is now Node137.
    const rebuildNode = await runRebuild(fake, 'node')
    expect(rebuildNode.ok).toBe(true)
    expect(rebuildNode.postCheck?.ok).toBe(true)
    expect(rebuildNode.postCheck?.abi).toBe(NODE_ABI)

    // 3. Electron check against the Node binding -> FAIL with repair command.
    const checkElectron = runCheck(fake, 'electron')
    expect(checkElectron.ok).toBe(false)
    expect(checkElectron.failures.join('\n')).toContain('pnpm native:rebuild:electron')

    // 4. Explicit Electron rebuild -> post-check PASSES.
    const rebuildElectron = await runRebuild(fake, 'electron')
    expect(rebuildElectron.ok).toBe(true)
    expect(rebuildElectron.postCheck?.abi).toBe(ELECTRON_ABI)

    // 5. Node check is broken again -> FAIL (single-binding limitation).
    const checkNode2 = runCheck(fake, 'node')
    expect(checkNode2.ok).toBe(false)
    expect(checkNode2.failures.join('\n')).toContain('pnpm native:rebuild:node')
  })
})

describe('CLI dispatch surface', () => {
  it('runCheck dispatches to the target-specific implementation', () => {
    const fake = new FakeEffects({ probeNode: okProbe, electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    const nodeReport = runCheck(fake, 'node')
    const electronReport = runCheck(fake, 'electron')
    expect(nodeReport.target).toBe('node')
    expect(electronReport.target).toBe('electron')
    expect(nodeReport.ok).toBe(true)
    expect(electronReport.ok).toBe(true)
  })
})

describe('report formatting of probe diagnostics (finding H)', () => {
  it('formats probe exit code and close error lines when present', () => {
    const report: CheckReport = {
      target: 'electron',
      ok: false,
      runtimeName: 'electron',
      runtimeVersion: ELECTRON_VERSION,
      abi: ELECTRON_ABI,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '24.14.1',
      markerState: 'ignored',
      sqlVerified: false,
      probeExitCode: 7,
      probeCloseError: 'close boom',
      failures: ['Electron runtime SQL probe failed: boom']
    }
    const text = formatCheckReport(report)
    expect(text).toContain('probe exit:')
    expect(text).toContain('7')
    expect(text).toContain('close boom')
  })

  it('omits probe diagnostic lines when absent', () => {
    const report: CheckReport = {
      target: 'node',
      ok: true,
      runtimeName: 'node',
      runtimeVersion: '24.12.0',
      abi: NODE_ABI,
      platform: 'darwin',
      arch: 'arm64',
      markerState: 'ignored',
      sqlVerified: true,
      failures: []
    }
    const text = formatCheckReport(report)
    expect(text).not.toContain('probe exit:')
    expect(text).not.toContain('probe close:')
  })
})

// ---------------------------------------------------------------------------
// Finding A: exact better-sqlite3 version enforcement. A dependency-version
// mismatch must fail with dependency remediation and never claim a rebuild can
// repair it (repairCommand is cleared).
// ---------------------------------------------------------------------------

describe('native ABI version enforcement (finding A)', () => {
  function breakPackageVersion(fake: FakeEffects, version: string): void {
    fake.vfs.addFile(path.join(PKG_REAL, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version }))
  }

  it('check:node FAILS on a version mismatch with dependency remediation (no rebuild repair claim)', () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding()
    breakPackageVersion(fake, '12.10.0')
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    expect(failures).toContain('12.10.0')
    expect(failures).toContain(NATIVE_PACKAGE_VERSION)
    expect(failures).toContain('pnpm install')
    expect(failures).toContain('native rebuild cannot repair')
    expect(report.repairCommand).toBeUndefined()
  })

  it('check:electron FAILS on a version mismatch before any probe spawn', () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    breakPackageVersion(fake, '13.0.0')
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('13.0.0')
    expect(report.failures.join('\n')).toContain('pnpm install')
    expect(report.repairCommand).toBeUndefined()
    expect(fake.calls.some((c) => c.startsWith('spawnElectronProbe'))).toBe(false)
  })

  it('rebuild:node FAILS on a version mismatch before any build step', async () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding()
    breakPackageVersion(fake, '12.9.0')
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('12.9.0')
    expect(report.failures.join('\n')).toContain('pnpm install')
    expect(report.repairCommand).toBeUndefined()
    expect(fake.calls).not.toContain('runNodeGyp')
  })

  it('rebuild:electron FAILS on a version mismatch before any rebuild call', async () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    breakPackageVersion(fake, '14.0.0')
    const report = await runRebuild(fake, 'electron')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('14.0.0')
    expect(report.repairCommand).toBeUndefined()
    expect(fake.calls).not.toContain('rebuildElectron')
  })

  it('passes when the resolved version exactly matches the locked version', () => {
    const fake = new FakeEffects({ probeNode: okProbe, electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    expect(runNodeCheck(fake).ok).toBe(true)
    expect(runElectronCheck(fake).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Finding B: the compiled/<nodeRuntimeVersion>/... candidate is resolved with
// the target runtime's Node version through the real check flows.
// ---------------------------------------------------------------------------

describe('compiled candidate runtime-version semantics in checks (finding B)', () => {
  it('check:node resolves the binding via compiled/<host node version>/<platform>/<arch>', () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding({ exists: false })
    const compiled = path.join(PKG_REAL, 'compiled', '24.12.0', 'darwin', 'arm64', 'better_sqlite3.node')
    fake.vfs.addFile(compiled, 'bytes')
    const report = runNodeCheck(fake)
    expect(report.ok).toBe(true)
    expect(report.bindingPath).toBe(compiled)
  })

  it('check:electron uses the Electron embedded Node version for the compiled candidate', () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({ nodeVersion: '24.14.1' }) })
    fake.addPackageBinding({ exists: false })
    const compiled = path.join(PKG_REAL, 'compiled', '24.14.1', 'darwin', 'arm64', 'better_sqlite3.node')
    fake.vfs.addFile(compiled, 'bytes')
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(true)
    expect(report.bindingPath).toBe(compiled)
  })

  it('check:electron failure still reports the resolved binding path and probe runtime facts (finding E)', () => {
    const fake = new FakeEffects({
      electronProbe: probeStdout({ ok: false, sqlOk: false, error: 'dlopen failed: ABI mismatch' })
    })
    fake.addPackageBinding()
    const report = runElectronCheck(fake)
    expect(report.ok).toBe(false)
    expect(report.bindingPath).toBe(BINDING_RELEASE)
    expect(report.runtimeVersion).toBe(ELECTRON_VERSION)
    expect(report.abi).toBe(ELECTRON_ABI)
    expect(report.nodeVersion).toBe('24.14.1')
    const failures = report.failures.join('\n')
    expect(failures).toContain('dlopen failed: ABI mismatch')
    expect(failures).toContain(BINDING_RELEASE)
    expect(failures).toContain(PKG_REAL)
  })
})

// ---------------------------------------------------------------------------
// Finding C: marker / stale-bin cleanup failures are observable and fail the
// rebuild; absent optional stale directories are never errors.
// ---------------------------------------------------------------------------

describe('cleanup failure observability (finding C)', () => {
  it('marker invalidation failure after a failed rebuild is preserved in the report', async () => {
    const fake = new FakeEffects({
      probeNode: okProbe,
      nodeGypResult: { code: 1, stdout: 'gyp ERR! build error', stderr: '' },
      removeFileError: 'EACCES: permission denied'
    })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    expect(failures).toContain('marker invalidation failed')
    expect(failures).toContain('EACCES: permission denied')
  })

  it('marker invalidation failure after a failed post-check is preserved in the report', async () => {
    const fake = new FakeEffects({
      probeNode: { ok: false, sqlOk: false, error: 'still broken' },
      nodeGypResult: { code: 0, stdout: 'gyp ok', stderr: '' },
      removeFileError: 'EACCES'
    })
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    expect(report.failures.join('\n')).toContain('marker invalidation failed')
    expect(report.failures.join('\n')).toContain('EACCES')
  })

  it('stale bin dir removal failure makes a successful rebuild FAIL', async () => {
    const fake = new FakeEffects({ probeNode: okProbe, removeDirError: 'EACCES' })
    fake.addPackageBinding()
    fake.vfs.mkdirp(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    expect(failures).toContain('post-rebuild cleanup failed')
    expect(failures).toContain('EACCES')
  })

  it('absent optional stale dirs never fail a rebuild (absence is not an error)', async () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding({ electronBin: false })
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(true)
    expect(report.failures).toHaveLength(0)
  })

  it('removeMarkers bounds every removal by the resolved package path', () => {
    const fake = new FakeEffects()
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    const errors = removeMarkers(fake, PKG_REAL)
    expect(errors).toEqual([])
    expect(fake.lastRemoveFileBoundary).toBe(PKG_REAL)
    expect(fake.vfs.exists(MARKER_RELEASE)).toBe(false)
  })

  it('removeStaleBinDirs bounds every removal by the resolved package path', () => {
    const fake = new FakeEffects()
    fake.addPackageBinding()
    fake.vfs.mkdirp(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))
    const errors = removeStaleBinDirs(fake, PKG_REAL, NODE_ABI, 'darwin', 'arm64')
    expect(errors).toEqual([])
    expect(fake.lastRemoveDirBoundary).toBe(PKG_REAL)
    expect(fake.vfs.exists(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Finding H: directory enumeration distinguishes ENOENT (empty) from all other
// failures. Marker / stale-bin enumeration errors must reach the rebuild result
// and prevent success; a missing dir is never an error.
// ---------------------------------------------------------------------------

describe('directory enumeration failure observability (finding H)', () => {
  it('a marker build-dir enumeration failure blocks the rebuild before any build step', async () => {
    const fake = new FakeEffects({ probeNode: okProbe, listDirError: 'EACCES: permission denied' })
    fake.addPackageBinding()
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    expect(failures).toContain('marker enumeration failed')
    expect(failures).toContain('EACCES')
    // Fail-fast: no build step ran once enumeration was impossible.
    expect(fake.calls).not.toContain('runNodeGyp')
    expect(fake.calls).not.toContain('rebuildElectron')
  })

  it('a marker build-dir enumeration failure during invalidation is observable (removeMarkers)', () => {
    const fake = new FakeEffects()
    fake.addPackageBinding({ marker: `arm64--${ELECTRON_ABI}` })
    fake.listDir = (p): DirListing =>
      p === path.join(PKG_REAL, 'build')
        ? { ok: false, error: 'listDir(/pkg/build): EACCES: permission denied' }
        : { ok: true, entries: fake.vfs.listDir(p) }
    const errors = removeMarkers(fake, PKG_REAL)
    expect(errors.join('\n')).toContain('EACCES')
  })

  it('a stale-bin directory enumeration failure makes a successful rebuild FAIL', async () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding()
    fake.vfs.mkdirp(path.join(PKG_REAL, 'bin', `darwin-arm64-${ELECTRON_ABI}`))
    // Only the bin/ enumeration fails; build-dir marker enumeration stays healthy.
    fake.listDir = (p): DirListing =>
      p === path.join(PKG_REAL, 'bin')
        ? { ok: false, error: 'listDir(/pkg/bin): EACCES: permission denied' }
        : { ok: true, entries: fake.vfs.listDir(p) }
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(false)
    const failures = report.failures.join('\n')
    expect(failures).toContain('post-rebuild cleanup failed')
    expect(failures).toContain('EACCES')
  })

  it('a stale-bin enumeration failure is observable directly (removeStaleBinDirs)', () => {
    const fake = new FakeEffects()
    fake.addPackageBinding()
    fake.listDir = (p): DirListing =>
      p === path.join(PKG_REAL, 'bin')
        ? { ok: false, error: 'listDir(/pkg/bin): EIO: input/output error' }
        : { ok: true, entries: fake.vfs.listDir(p) }
    const errors = removeStaleBinDirs(fake, PKG_REAL, NODE_ABI, 'darwin', 'arm64')
    expect(errors.join('\n')).toContain('EIO')
  })

  it('the real Effects listDir treats ENOENT as empty but reports other errors', () => {
    const effects = createEffects()
    // A definitely-missing directory must resolve to an empty, ok listing.
    const missing = effects.listDir(path.join(os.tmpdir(), 'definitely-missing-dir-native-abi-test'))
    expect(missing).toEqual({ ok: true, entries: [] })
    // A path that cannot be listed (a file, not a dir) must be an observable failure.
    const filePath = path.join(os.tmpdir(), 'native-abi-not-a-dir.txt')
    fs.writeFileSync(filePath, 'x')
    try {
      const listing = effects.listDir(filePath)
      expect(listing.ok).toBe(false)
      if (!listing.ok) {
        expect(listing.error).toContain(filePath)
      }
    } finally {
      fs.rmSync(filePath, { force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Safe marker removal (post-rebuild ENOTDIR regression). The real
// `removeFile` must validate parent path components within the resolved
// package boundary while the terminal marker path is a regular file. After a
// node-gyp build, `build/` holds regular files (`Makefile`, `config.gypi`,
// ...) that `markerPaths` enumerates as marker subdirectories; the pre-fix
// `fs.rmSync(force)` failed each of those bogus paths with
// `ENOTDIR: not a directory, lstat ...` — six errors in real validation.
// ---------------------------------------------------------------------------

describe('real Effects safe file removal (post-rebuild ENOTDIR regression)', () => {
  const effects = createEffects()
  let tmp: string
  let pkg: string

  const BUILD_FILES = ['Makefile', 'binding.Makefile', 'config.gypi', 'action_before_build', 'node', 'build.ninja']

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-remove-'))
    pkg = path.join(tmp, 'better-sqlite3')
    fs.mkdirSync(path.join(pkg, 'build', 'Release'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('removes a regular marker file inside the boundary', () => {
    const marker = path.join(pkg, 'build', 'Release', '.forge-meta')
    fs.writeFileSync(marker, 'arm64--145')
    expect(effects.removeFile(marker, pkg)).toBeUndefined()
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('treats a marker path under a regular file parent as a no-op (the six-ENOTDIR regression)', () => {
    for (const f of BUILD_FILES) {
      fs.writeFileSync(path.join(pkg, 'build', f), '# gyp artifact\n')
    }
    fs.writeFileSync(path.join(pkg, 'build', 'Release', '.forge-meta'), 'arm64--145')
    // markerPaths enumerates every build/ entry as a marker subdirectory.
    const listing = effects.listDir(path.join(pkg, 'build'))
    expect(listing.ok).toBe(true)
    const errors: string[] = []
    if (listing.ok) {
      for (const entry of listing.entries) {
        if (entry === '.node') {
          continue
        }
        const err = effects.removeFile(path.join(pkg, 'build', entry, '.forge-meta'), pkg)
        if (err) {
          errors.push(err)
        }
      }
    }
    // Pre-fix: 6 x `ENOTDIR: not a directory, lstat .../build/<file>/.forge-meta`.
    // Post-fix: every bogus path is a no-op and the real marker is removed.
    expect(errors).toEqual([])
    expect(fs.existsSync(path.join(pkg, 'build', 'Release', '.forge-meta'))).toBe(false)
    for (const f of BUILD_FILES) {
      expect(fs.existsSync(path.join(pkg, 'build', f))).toBe(true)
    }
  })

  it('removeMarkers cleans a post-build build/ dir with zero errors (no manual marker)', () => {
    for (const f of BUILD_FILES) {
      fs.writeFileSync(path.join(pkg, 'build', f), '# gyp artifact\n')
    }
    fs.writeFileSync(path.join(pkg, 'build', 'Release', '.forge-meta'), 'arm64--145')
    const errors = removeMarkers(effects, pkg)
    expect(errors).toEqual([])
    expect(fs.existsSync(path.join(pkg, 'build', 'Release', '.forge-meta'))).toBe(false)
    expect(fs.existsSync(path.join(pkg, 'build', 'Makefile'))).toBe(true)
  })

  it('removes nested markers (Release and Debug)', () => {
    fs.mkdirSync(path.join(pkg, 'build', 'Debug'))
    fs.writeFileSync(path.join(pkg, 'build', 'Release', '.forge-meta'), 'release-marker')
    fs.writeFileSync(path.join(pkg, 'build', 'Debug', '.forge-meta'), 'debug-marker')
    const errors = removeMarkers(effects, pkg)
    expect(errors).toEqual([])
    expect(fs.existsSync(path.join(pkg, 'build', 'Release', '.forge-meta'))).toBe(false)
    expect(fs.existsSync(path.join(pkg, 'build', 'Debug', '.forge-meta'))).toBe(false)
  })

  it('is ENOENT tolerant: missing markers and missing parents are no-ops', () => {
    expect(effects.removeFile(path.join(pkg, 'build', 'Release', '.forge-meta'), pkg)).toBeUndefined()
    expect(effects.removeFile(path.join(pkg, 'no-such-dir', '.forge-meta'), pkg)).toBeUndefined()
  })

  it('refuses a path that escapes the boundary with ..', () => {
    const outside = path.join(tmp, 'outside-marker')
    fs.writeFileSync(outside, 'x')
    const err = effects.removeFile(path.join(pkg, '..', 'outside-marker'), pkg)
    expect(err).toBeDefined()
    if (err) {
      expect(err).toContain('escapes the package boundary')
    }
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('refuses a parent symlink that resolves outside the boundary', () => {
    const outside = path.join(tmp, 'outside-dir')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, '.forge-meta'), 'x')
    fs.rmSync(path.join(pkg, 'build', 'Release'), { recursive: true, force: true })
    fs.symlinkSync(outside, path.join(pkg, 'build', 'Release'))
    const err = effects.removeFile(path.join(pkg, 'build', 'Release', '.forge-meta'), pkg)
    expect(err).toBeDefined()
    if (err) {
      expect(err).toContain('escapes the package boundary')
    }
    expect(fs.existsSync(path.join(outside, '.forge-meta'))).toBe(true)
  })

  it('refuses a terminal symlink that resolves outside the boundary', () => {
    const outside = path.join(tmp, 'outside-marker')
    fs.writeFileSync(outside, 'x')
    fs.symlinkSync(outside, path.join(pkg, 'build', 'Release', '.forge-meta'))
    const err = effects.removeFile(path.join(pkg, 'build', 'Release', '.forge-meta'), pkg)
    expect(err).toBeDefined()
    if (err) {
      expect(err).toContain('escapes the package boundary')
    }
    expect(fs.existsSync(outside)).toBe(true)
    expect(fs.existsSync(path.join(pkg, 'build', 'Release', '.forge-meta'))).toBe(true)
  })

  it('unlinks a dangling terminal symlink (no escape possible)', () => {
    fs.symlinkSync(
      path.join(pkg, 'build', 'Release', 'missing-target'),
      path.join(pkg, 'build', 'Release', '.forge-meta')
    )
    expect(effects.removeFile(path.join(pkg, 'build', 'Release', '.forge-meta'), pkg)).toBeUndefined()
    expect(fs.existsSync(path.join(pkg, 'build', 'Release', '.forge-meta'))).toBe(false)
  })

  it('refuses to remove a directory through removeFile (removeDir stays the directory cleanup)', () => {
    const err = effects.removeFile(path.join(pkg, 'build', 'Release'), pkg)
    expect(err).toBeDefined()
    if (err) {
      expect(err).toContain('removeDir')
    }
    expect(fs.statSync(path.join(pkg, 'build', 'Release')).isDirectory()).toBe(true)
  })

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  it.skipIf(isRoot)('observes permission failures as errors (finding C)', () => {
    const marker = path.join(pkg, 'build', 'Release', '.forge-meta')
    fs.writeFileSync(marker, 'arm64--145')
    fs.chmodSync(path.join(pkg, 'build', 'Release'), 0o555)
    try {
      const err = effects.removeFile(marker, pkg)
      expect(err).toBeDefined()
      if (err) {
        expect(err).toContain('removeFile(')
      }
    } finally {
      fs.chmodSync(path.join(pkg, 'build', 'Release'), 0o755)
    }
    expect(fs.existsSync(marker)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Safe recursive directory removal (stale-bin boundary hardening). The real
// `removeDir` must apply the same resolved-package-boundary contract as
// `removeFile`: a symlinked `bin` resolving outside the package (or a
// symlinked stale entry pointing outside) is rejected before any recursive
// deletion; in-boundary stale dirs are removed; ENOENT is a no-op; permission
// failures stay observable. `fs.rmSync(recursive)` never follows symlinks, so
// the validated parent chain is the only external reach.
// ---------------------------------------------------------------------------

describe('real Effects safe recursive directory removal (stale-bin boundary)', () => {
  const effects = createEffects()
  let tmp: string
  let pkg: string
  let outside: string

  const STALE_ABI = 137 // the "other" ABI when keeping 145

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-rmdir-'))
    pkg = path.join(tmp, 'better-sqlite3')
    outside = path.join(tmp, 'outside')
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
    fs.mkdirSync(outside)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('rejects a symlinked bin/ resolving outside the package (external tree untouched)', () => {
    // bin/ itself is a symlink to an external dir holding a stale-named entry.
    fs.mkdirSync(path.join(outside, `darwin-arm64-${STALE_ABI}`))
    fs.writeFileSync(path.join(outside, `darwin-arm64-${STALE_ABI}`, 'better_sqlite3.node'), 'bytes')
    fs.rmSync(path.join(pkg, 'bin'), { recursive: true, force: true })
    fs.symlinkSync(outside, path.join(pkg, 'bin'))
    const errors = removeStaleBinDirs(effects, pkg, ELECTRON_ABI, 'darwin', 'arm64')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('escapes the package boundary')
    expect(errors[0]).toContain('removeDir(')
    // The external tree is intact — the escape was rejected before deletion.
    expect(fs.existsSync(path.join(outside, `darwin-arm64-${STALE_ABI}`, 'better_sqlite3.node'))).toBe(true)
  })

  it('rejects a symlinked stale bin entry pointing outside (external tree untouched)', () => {
    // bin/ is real but the stale entry itself is a symlink to an external dir.
    fs.mkdirSync(path.join(outside, `darwin-arm64-${STALE_ABI}`))
    fs.writeFileSync(path.join(outside, `darwin-arm64-${STALE_ABI}`, 'better_sqlite3.node'), 'bytes')
    fs.symlinkSync(outside, path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))
    const errors = removeStaleBinDirs(effects, pkg, ELECTRON_ABI, 'darwin', 'arm64')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('escapes the package boundary')
    expect(fs.existsSync(path.join(outside, `darwin-arm64-${STALE_ABI}`, 'better_sqlite3.node'))).toBe(true)
  })

  it('removes a valid in-boundary stale dir recursively with zero errors', () => {
    fs.mkdirSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`, 'better_sqlite3.node'), 'bytes')
    fs.mkdirSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`, 'nested'))
    const errors = removeStaleBinDirs(effects, pkg, ELECTRON_ABI, 'darwin', 'arm64')
    expect(errors).toEqual([])
    expect(fs.existsSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))).toBe(false)
    // bin/ itself is untouched.
    expect(fs.statSync(path.join(pkg, 'bin')).isDirectory()).toBe(true)
  })

  it('keeps the kept-ABI dir when only stale ABIs differ', () => {
    fs.mkdirSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))
    fs.mkdirSync(path.join(pkg, 'bin', `darwin-arm64-${ELECTRON_ABI}`))
    fs.writeFileSync(path.join(pkg, 'bin', `darwin-arm64-${ELECTRON_ABI}`, 'better_sqlite3.node'), 'bytes')
    const errors = removeStaleBinDirs(effects, pkg, ELECTRON_ABI, 'darwin', 'arm64')
    expect(errors).toEqual([])
    expect(fs.existsSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))).toBe(false)
    expect(fs.existsSync(path.join(pkg, 'bin', `darwin-arm64-${ELECTRON_ABI}`))).toBe(true)
    expect(fs.existsSync(path.join(pkg, 'bin', `darwin-arm64-${ELECTRON_ABI}`, 'better_sqlite3.node'))).toBe(true)
  })

  it('refuses a path that escapes the boundary with ..', () => {
    const outsideDir = path.join(outside, 'victim')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'file.txt'), 'x')
    const err = effects.removeDir(path.join(pkg, '..', 'outside', 'victim'), pkg)
    expect(err).toBeDefined()
    if (err) {
      expect(err).toContain('escapes the package boundary')
      expect(err).toContain('removeDir(')
    }
    expect(fs.existsSync(path.join(outsideDir, 'file.txt'))).toBe(true)
  })

  it('is ENOENT tolerant: a missing stale dir and missing parents are no-ops', () => {
    expect(effects.removeDir(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`), pkg)).toBeUndefined()
    expect(effects.removeDir(path.join(pkg, 'no-such-bin', `darwin-arm64-${STALE_ABI}`), pkg)).toBeUndefined()
  })

  it('unlinks a dangling terminal symlink (no escape possible)', () => {
    fs.symlinkSync(path.join(pkg, 'bin', 'missing-target'), path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))
    const errors = removeStaleBinDirs(effects, pkg, ELECTRON_ABI, 'darwin', 'arm64')
    expect(errors).toEqual([])
    expect(fs.existsSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))).toBe(false)
  })

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  it.skipIf(isRoot)('observes permission failures as errors (finding C)', () => {
    // bin/ is read+execute (no write): enumeration works, recursive deletion
    // of the child must fail with an observable EACCES, not silently succeed.
    fs.mkdirSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))
    fs.chmodSync(path.join(pkg, 'bin'), 0o555)
    try {
      const err = effects.removeDir(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`), pkg)
      expect(err).toBeDefined()
      if (err) {
        expect(err).toContain('removeDir(')
      }
    } finally {
      fs.chmodSync(path.join(pkg, 'bin'), 0o755)
    }
    expect(fs.existsSync(path.join(pkg, 'bin', `darwin-arm64-${STALE_ABI}`))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Finding G: the full real rebuild option objects are asserted end-to-end.
// ---------------------------------------------------------------------------

describe('full rebuild option objects (finding G)', () => {
  it('Node rebuild passes the complete node-gyp option object', async () => {
    const fake = new FakeEffects({ probeNode: okProbe })
    fake.addPackageBinding()
    const report = await runRebuild(fake, 'node')
    expect(report.ok).toBe(true)
    expect(fake.nodeGypOpts).toEqual({
      packagePath: PKG_REAL,
      nodeGypJs: fake.nodeGypJsPath(),
      execPath: fake.execPath,
      nodeDir: path.join(path.sep, 'node24'),
      arch: fake.arch,
      platform: fake.platform
    })
  })

  it('Electron rebuild passes the complete @electron/rebuild option object', async () => {
    const fake = new FakeEffects({ electronProbe: probeStdout({}) })
    fake.addPackageBinding()
    const report = await runRebuild(fake, 'electron')
    expect(report.ok).toBe(true)
    expect(fake.electronRebuildOpts).toEqual({
      buildPath: path.join(path.sep, 'repo'),
      electronVersion: ELECTRON_VERSION,
      platform: 'darwin',
      arch: 'arm64',
      onlyModules: ['better-sqlite3'],
      force: true,
      buildFromSource: true,
      projectRootPath: path.join(path.sep, 'repo'),
      mode: 'sequential'
    })
  })
})

// ---------------------------------------------------------------------------
// Finding D: narrow real subprocess coverage of probe.cjs (spawned under plain
// Node with a stub module via NATIVE_ABI_PROBE_MODULE). This is read-only for
// the repo (test-owned temp dir only) and does not depend on the current ABI.
// The real binding SQL evidence is the final `native:check:electron` runtime
// validation, which is the evidence boundary for the real ABI state.
// ---------------------------------------------------------------------------

describe('probe.cjs real subprocess emission contract (finding D)', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-probe-'))

  function writeStub(name: string, body: string): string {
    const p = path.join(tmpBase, `${name}.cjs`)
    fs.writeFileSync(p, body)
    return p
  }

  function runProbe(stub: string, extraEnv: Record<string, string> = {}) {
    const closeMarker = path.join(tmpBase, `close-${path.basename(stub)}.marker`)
    try {
      fs.rmSync(closeMarker, { force: true })
    } catch {
      // ignore
    }
    const res = spawnSync(process.execPath, [PROBE_PATH], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [PROBE_TEST_SEAM_ENV]: '1', // explicit seam gate (LOCK-ABI-2) — the stub is honored only under this
        [PROBE_MODULE_ENV]: stub,
        [PROBE_MARKER_ENV]: PROBE_MARKER,
        CLOSE_MARKER_PATH: closeMarker,
        ...extraEnv
      }
    })
    const probe = parseProbeOutput((res.stdout ?? '') + (res.stderr ?? ''))
    return { probe, code: res.status ?? 1, closeMarker, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  it('emits ok:true/sqlOk:true and exit 0 and closes the Database on the happy path', () => {
    const stub = writeStub(
      'ok',
      `'use strict'
        module.exports = class Database {
          constructor(file) { this.file = file }
          prepare() { return { get: () => ({ ok: 1 }) } }
          close() { require('fs').writeFileSync(process.env.CLOSE_MARKER_PATH, 'closed') }
        }`
    )
    const { probe, code, closeMarker } = runProbe(stub)
    expect(probe?.ok).toBe(true)
    expect(probe?.sqlOk).toBe(true)
    expect(code).toBe(0)
    expect(fs.existsSync(closeMarker)).toBe(true)
  })

  it('emits ok:false/sqlOk:false and exit 1 when the SQL row is not exactly ok:1 (never ok:true/exit 0)', () => {
    const stub = writeStub(
      'sqlfalse',
      `'use strict'
        module.exports = class Database {
          constructor(file) { this.file = file }
          prepare() { return { get: () => ({ ok: 2 }) } }
          close() { require('fs').writeFileSync(process.env.CLOSE_MARKER_PATH, 'closed') }
        }`
    )
    const { probe, code, closeMarker } = runProbe(stub)
    expect(probe?.ok).toBe(false)
    expect(probe?.sqlOk).toBe(false)
    expect(probe?.error).toContain('unexpected row')
    expect(code).toBe(1)
    expect(fs.existsSync(closeMarker)).toBe(true)
  })

  it('preserves the primary error and still closes the Database in finally when prepare throws', () => {
    const stub = writeStub(
      'throw',
      `'use strict'
        module.exports = class Database {
          constructor(file) { this.file = file }
          prepare() { throw new Error('prepare boom') }
          close() { require('fs').writeFileSync(process.env.CLOSE_MARKER_PATH, 'closed') }
        }`
    )
    const { probe, code, closeMarker } = runProbe(stub)
    expect(probe?.ok).toBe(false)
    expect(probe?.sqlOk).toBe(false)
    expect(probe?.error).toContain('prepare boom')
    expect(code).toBe(1)
    // finally-close ran even though the SQL step threw (no leak).
    expect(fs.existsSync(closeMarker)).toBe(true)
  })

  it('preserves a close error and exits nonzero when Database.close() throws', () => {
    const stub = writeStub(
      'closefail',
      `'use strict'
        module.exports = class Database {
          constructor(file) { this.file = file }
          prepare() { return { get: () => ({ ok: 1 }) } }
          close() { throw new Error('close boom') }
        }`
    )
    const { probe, code } = runProbe(stub)
    expect(probe?.ok).toBe(false)
    expect(probe?.closeError).toContain('close boom')
    expect(code).toBe(1)
  })

  it('exits nonzero when the module fails to load (primary error preserved)', () => {
    const stub = writeStub(
      'loadfail',
      `'use strict'
        throw new Error('module load failed')`
    )
    const { probe, code } = runProbe(stub)
    expect(probe?.ok).toBe(false)
    expect(probe?.sqlOk).toBe(false)
    expect(probe?.error).toContain('module load failed')
    expect(code).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// LOCK-ABI-2 hardening: the production probe proof can never be redirected by
// an inherited environment, and the stub module is honored only under the
// explicit test-seam gate. The real probe is spawned under plain Node so the
// current native ABI never matters: what is asserted is that the malicious
// stub is NOT loaded and the probe still emits its production marker record.
// ---------------------------------------------------------------------------

describe('probe production-mode hardening (LOCK-ABI-2)', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-probe-hardening-'))

  function writeMaliciousStub(): string {
    const p = path.join(tmpBase, 'malicious.cjs')
    fs.writeFileSync(
      p,
      `'use strict'
        throw new Error('MALICIOUS_PROBE_STUB_LOADED at ' + __filename)`
    )
    return p
  }

  it('production spawnElectronProbe strips inherited NATIVE_ABI_PROBE_MODULE and the test seam', () => {
    const stub = writeMaliciousStub()
    const savedModule = process.env[PROBE_MODULE_ENV]
    const savedSeam = process.env[PROBE_TEST_SEAM_ENV]
    process.env[PROBE_MODULE_ENV] = stub
    process.env[PROBE_TEST_SEAM_ENV] = '1'
    try {
      const effects = createEffects()
      const res = effects.spawnElectronProbe(process.execPath, PROBE_PATH)
      const output = res.stdout + res.stderr
      // The inherited malicious stub must never be loaded by the production path.
      expect(output).not.toContain('MALICIOUS_PROBE_STUB_LOADED')
      expect(output).not.toContain(stub)
      // The real probe still ran in production mode and emitted its record.
      const probe = parseProbeOutput(output)
      expect(probe).toBeDefined()
      expect(probe?.runtime).toBe('node')
      expect(probe?.version).toBe(process.versions.node)
    } finally {
      if (savedModule === undefined) {
        delete process.env[PROBE_MODULE_ENV]
      } else {
        process.env[PROBE_MODULE_ENV] = savedModule
      }
      if (savedSeam === undefined) {
        delete process.env[PROBE_TEST_SEAM_ENV]
      } else {
        process.env[PROBE_TEST_SEAM_ENV] = savedSeam
      }
    }
  })

  it('the stub module is honored ONLY under the explicit test-seam gate', () => {
    const stub = writeMaliciousStub()
    const spawn = (extraEnv: Record<string, string>) =>
      spawnSync(process.execPath, [PROBE_PATH], {
        encoding: 'utf8',
        env: { ...process.env, [PROBE_MODULE_ENV]: stub, [PROBE_MARKER_ENV]: PROBE_MARKER, ...extraEnv }
      })

    // Without the gate: NATIVE_ABI_PROBE_MODULE alone is ignored — production
    // mode hardcodes the real package contract and never loads the stub.
    const noSeam = spawn({})
    expect((noSeam.stdout ?? '') + (noSeam.stderr ?? '')).not.toContain('MALICIOUS_PROBE_STUB_LOADED')

    // With the gate: the direct test helper invocation works as before.
    const withSeam = spawn({ [PROBE_TEST_SEAM_ENV]: '1' })
    expect((withSeam.stdout ?? '') + (withSeam.stderr ?? '')).toContain('MALICIOUS_PROBE_STUB_LOADED')
  })
})

// ---------------------------------------------------------------------------
// LOCK-ABI-5/7: the Node rebuild child environment is sanitized against every
// target-affecting npm/node-gyp override and the verified arch/platform facts
// are re-injected; proxy/compiler vars survive. Faithful coverage: a pure
// sanitizer unit test plus real subprocess spawns that dump the child env/argv.
// ---------------------------------------------------------------------------

describe('Node rebuild environment sanitization (LOCK-ABI-5/7)', () => {
  it('sanitizeNodeGypEnv strips every target-affecting variant and re-injects verified facts', () => {
    const hostile: NodeJS.ProcessEnv = {
      PATH: '/verified/node24/bin:/usr/bin',
      npm_config_runtime: 'electron',
      npm_config_target: '41.2.1',
      npm_config_target_arch: 'x64',
      npm_config_arch: 'x64',
      npm_config_dist_url: 'https://evil.example/headers',
      npm_config_nodedir: '/evil/headers',
      npm_config_devdir: '/evil/dev',
      npm_config_electron_version: '41.2.1',
      npm_config_build_from_source: 'false',
      npm_config_platform: 'win32',
      NPM_CONFIG_RUNTIME: 'electron',
      NPM_CONFIG_TARGET: '42.0.0',
      NPM_CONFIG_DIST_URL: 'https://evil.example',
      NPM_CONFIG_NODEDIR: '/evil/headers2',
      NPM_CONFIG_BUILD_FROM_SOURCE: 'false',
      runtime: 'electron',
      target: '41.2.1',
      target_arch: 'x64',
      dist_url: 'https://evil.example',
      nodedir: '/evil',
      devdir: '/evil-dev',
      electron_version: '41.2.1',
      build_from_source: 'false',
      arch: 'x64',
      platform: 'win32',
      HTTPS_PROXY: 'http://proxy.local:8080',
      CC: 'clang'
    }
    const clean = sanitizeNodeGypEnv(hostile, 'arm64', 'darwin')
    // The inherited target-affecting forms are stripped entirely.
    const stripped = [
      'npm_config_runtime',
      'npm_config_target',
      'npm_config_dist_url',
      'npm_config_nodedir',
      'npm_config_devdir',
      'npm_config_electron_version',
      'NPM_CONFIG_RUNTIME',
      'NPM_CONFIG_TARGET',
      'NPM_CONFIG_DIST_URL',
      'NPM_CONFIG_NODEDIR',
      'NPM_CONFIG_BUILD_FROM_SOURCE',
      'runtime',
      'target',
      'target_arch',
      'dist_url',
      'nodedir',
      'devdir',
      'electron_version',
      'build_from_source',
      'arch',
      'platform'
    ]
    for (const key of stripped) {
      expect(clean[key]).toBeUndefined()
    }
    // The verified facts are re-injected (never the inherited conflicting ones).
    expect(clean.npm_config_arch).toBe('arm64')
    expect(clean.npm_config_target_arch).toBe('arm64')
    expect(clean.npm_config_platform).toBe('darwin')
    expect(clean.npm_config_build_from_source).toBe('true')
    // Proxy/compiler vars needed for the source build are preserved.
    expect(clean.HTTPS_PROXY).toBe('http://proxy.local:8080')
    expect(clean.CC).toBe('clang')
    expect(clean.PATH).toBe('/verified/node24/bin:/usr/bin')
  })

  it('real runNodeGyp child env excludes hostile overrides and receives controlled args', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-gyp-env-'))
    try {
      fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true })
      const dump = path.join(tmp, 'dump.cjs')
      fs.writeFileSync(
        dump,
        `'use strict'
          console.log('ARGV ' + JSON.stringify(process.argv.slice(2)))
          const keys = [
            'npm_config_runtime', 'npm_config_target', 'npm_config_nodedir', 'npm_config_dist_url',
            'NPM_CONFIG_RUNTIME', 'NPM_CONFIG_TARGET', 'npm_config_target_arch', 'npm_config_arch',
            'npm_config_platform', 'npm_config_build_from_source', 'npm_config_electron_version',
            'runtime', 'target', 'nodedir', 'dist_url', 'electron_version', 'build_from_source'
          ]
          const pick = {}
          for (const k of keys) if (process.env[k] !== undefined) pick[k] = process.env[k]
          console.log('ENV ' + JSON.stringify(pick))
          process.exit(0)`
      )
      const effects = createEffects()
      // Hostile inherited environment (test-owned; restored in finally).
      const saved = {
        npm_config_runtime: process.env.npm_config_runtime,
        npm_config_target: process.env.npm_config_target,
        npm_config_nodedir: process.env.npm_config_nodedir,
        npm_config_dist_url: process.env.npm_config_dist_url,
        npm_config_target_arch: process.env.npm_config_target_arch,
        NPM_CONFIG_RUNTIME: process.env.NPM_CONFIG_RUNTIME,
        runtime: process.env.runtime,
        target_arch: process.env.target_arch
      }
      process.env.npm_config_runtime = 'electron'
      process.env.npm_config_target = '41.2.1'
      process.env.npm_config_nodedir = '/evil/headers'
      process.env.npm_config_dist_url = 'https://evil.example'
      process.env.npm_config_target_arch = 'x64'
      process.env.NPM_CONFIG_RUNTIME = 'electron'
      process.env.runtime = 'electron'
      process.env.target_arch = 'x64'
      try {
        const res = effects.runNodeGyp({
          packagePath: path.join(tmp, 'pkg'),
          nodeGypJs: dump,
          execPath: process.execPath,
          nodeDir: '/verified/node24',
          arch: 'arm64',
          platform: 'darwin'
        })
        expect(res.code).toBe(0)
        const argv = JSON.parse(res.stdout.match(/ARGV (.*)/)?.[1] ?? '[]') as string[]
        expect(argv).toEqual([
          'rebuild',
          '--build-from-source',
          '--arch=arm64',
          '--nodedir=/verified/node24',
          '--platform=darwin'
        ])
        const env = JSON.parse(res.stdout.match(/ENV (.*)/)?.[1] ?? '{}') as Record<string, string>
        expect(env.npm_config_runtime).toBeUndefined()
        expect(env.npm_config_target).toBeUndefined()
        expect(env.npm_config_nodedir).toBeUndefined()
        expect(env.npm_config_dist_url).toBeUndefined()
        expect(env.npm_config_target_arch).toBe('arm64')
        expect(env.npm_config_arch).toBe('arm64')
        expect(env.npm_config_platform).toBe('darwin')
        expect(env.npm_config_build_from_source).toBe('true')
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('real runNodeGyp subprocess failure surfaces the exit code without success', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-gyp-fail-'))
    try {
      fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true })
      const fail = path.join(tmp, 'fail.cjs')
      fs.writeFileSync(fail, `'use strict'\nconsole.error('gyp ERR! build error')\nprocess.exit(1)\n`)
      const effects = createEffects()
      const res = effects.runNodeGyp({
        packagePath: path.join(tmp, 'pkg'),
        nodeGypJs: fail,
        execPath: process.execPath,
        nodeDir: '/verified/node24',
        arch: 'arm64',
        platform: 'darwin'
      })
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('gyp ERR!')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Finding F: preflight call graph — package.json wiring and CI steps. These
// assert the contract that aggregate entry points check once, focused sub-suite
// commands stay unguarded, and CI covers the focused-suite jobs directly.
// ---------------------------------------------------------------------------

describe('preflight call graph (finding F)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const scripts = pkg.scripts

  it('Electron-bearing entry points preflight native:check:electron once', () => {
    for (const name of ['start', 'dev', 'dev:watch', 'debug', 'test:e2e']) {
      expect(scripts[name]).toBeDefined()
      expect(scripts[name]).toContain('native:check:electron')
    }
  })

  it('aggregate Node entry points preflight native:check:node once', () => {
    for (const name of ['test', 'test:coverage', 'test:watch', 'test:ui', 'bench', 'ci:test-check']) {
      expect(scripts[name]).toBeDefined()
      expect(scripts[name]).toContain('native:check:node')
    }
  })

  it('focused sub-suite scripts stay unguarded by design (no duplicate checks)', () => {
    for (const name of [
      'test:main',
      'test:renderer',
      'test:aicore',
      'test:shared',
      'test:scripts',
      'test:e2e-utils',
      'bench:main',
      'bench:renderer',
      'bench:aicore',
      'bench:shared'
    ]) {
      expect(scripts[name]).toBeDefined()
      expect(scripts[name]).not.toContain('native:check')
    }
  })

  it('better-sqlite3 is pinned exactly to the locked version (finding A contract)', () => {
    const pkgFull = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkgFull.dependencies['better-sqlite3']).toBe(NATIVE_PACKAGE_VERSION)
  })

  it('CI jobs that call focused suites run one native:check:node before the tests', () => {
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

    const generalTest = ci.slice(ci.indexOf('general-test:'), ci.indexOf('render-test:'))
    const generalInstall = generalTest.indexOf('pnpm install')
    const generalCheck = generalTest.indexOf('pnpm native:check:node')
    const generalMain = generalTest.indexOf('pnpm test:main')
    expect(generalInstall).toBeGreaterThanOrEqual(0)
    expect(generalCheck).toBeGreaterThan(generalInstall)
    expect(generalMain).toBeGreaterThan(generalCheck)

    // Finding F2: the e2e-utils focused suite runs in the general-test job,
    // exactly once, sequenced after the other focused suites (which already
    // consumed the single native preflight).
    const generalScripts = generalTest.indexOf('pnpm test:scripts')
    const generalE2eUtils = generalTest.indexOf('pnpm test:e2e-utils')
    expect(generalE2eUtils).toBeGreaterThan(generalScripts)
    expect(generalTest.match(/pnpm test:e2e-utils/g)).toHaveLength(1)

    const renderTest = ci.slice(ci.indexOf('render-test:'))
    const renderInstall = renderTest.indexOf('pnpm install')
    const renderCheck = renderTest.indexOf('pnpm native:check:node')
    const renderRun = renderTest.indexOf('pnpm test:renderer')
    expect(renderInstall).toBeGreaterThanOrEqual(0)
    expect(renderCheck).toBeGreaterThan(renderInstall)
    expect(renderRun).toBeGreaterThan(renderCheck)
  })
})
