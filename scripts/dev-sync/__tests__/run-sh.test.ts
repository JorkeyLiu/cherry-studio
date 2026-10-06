import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const devSyncDir = join(here, '..')
const runSh = join(devSyncDir, 'run.sh')
const preflightJs = join(devSyncDir, 'runtime-preflight.js')
const repoRoot = join(here, '..', '..', '..')

const SH = '/bin/sh'
const REQUIRED_ABI = '137'
const pin = readFileSync(join(repoRoot, '.nvmrc'), 'utf8').trim()
const home = process.env.HOME ?? ''
const realPinNode = join(home, '.nvm', 'versions', 'node', `v${pin}`, 'bin', 'node')

let owned: string[] = []
/** A real installed node binary whose version/ABI differs from the pin (version- or ABI-mismatch). */
let wrongNodeBin = ''

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  owned.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true })
  owned = []
})

function probeRealNode(bin: string): { version: string; abi: string } | null {
  try {
    const v = spawnSync(bin, ['-v'], { encoding: 'utf8' })
    const a = spawnSync(bin, ['-p', 'process.versions.modules'], { encoding: 'utf8' })
    if (v.status !== 0 || a.status !== 0) return null
    return { version: String(v.stdout ?? '').trim(), abi: String(a.stdout ?? '').trim() }
  } catch {
    return null
  }
}

beforeAll(() => {
  expect(pin).toMatch(/^\d+\.\d+\.\d+/)
  expect(existsSync(runSh)).toBe(true)
  expect(existsSync(realPinNode)).toBe(true)
  const probed = probeRealNode(realPinNode)
  expect(probed?.version).toBe(`v${pin}`)
  expect(probed?.abi).toBe(REQUIRED_ABI)
  // Discover a real wrong-version/ABI node binary (proves candidate validation
  // against a truly-executed binary, not a version-faking hook).
  const seen = new Set<string>()
  const pathDirs = String(process.env.PATH ?? '').split(delimiter)
  for (const dir of [...pathDirs, join(home, '.nvm', 'versions', 'node', 'v24.12.0', 'bin')]) {
    const candidate = join(dir, 'node')
    if (!candidate || seen.has(candidate) || candidate === realPinNode) continue
    seen.add(candidate)
    if (!existsSync(candidate)) continue
    const facts = probeRealNode(candidate)
    if (!facts) continue
    if (facts.version.replace(/^[vV]/, '') !== pin || facts.abi !== REQUIRED_ABI) {
      wrongNodeBin = candidate
      break
    }
  }
  expect(wrongNodeBin.length).toBeGreaterThan(0)
})

/** Shell stub mimicking the reported Node22 host for `-v` / `-p` probes. */
function writeStubNode22(binDir: string): void {
  const body = [
    '#!/bin/sh',
    'if [ "$1" = "-v" ]; then echo "v22.23.1"; exit 0; fi',
    'if [ "$1" = "-p" ]; then',
    '  case "$2" in',
    '    *modules*) echo "127"; exit 0 ;;',
    '    *execPath*) echo "stub-node22"; exit 0 ;;',
    '  esac',
    '  echo "stub-node22: unsupported -p expr" >&2; exit 1',
    'fi',
    'echo "stub-node22: unsupported invocation" >&2; exit 1',
    ''
  ].join('\n')
  writeFileSync(join(binDir, 'node'), body)
  chmodSync(join(binDir, 'node'), 0o755)
}

type StubPnpmMode = 'ok' | 'exit42' | 'marker'

/**
 * Stub `pnpm`: records its argv plus the descendant `node` facts (version, ABI,
 * execPath, PATH) into the record dir, then behaves per mode. It never runs
 * the real Electron lane.
 */
function writeStubPnpm(binDir: string, recordDir: string, mode: StubPnpmMode): void {
  const footer = mode === 'ok' ? 'exit 0' : mode === 'exit42' ? 'exit 42' : `touch "${recordDir}/marker"\nexit 0`
  const body = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${recordDir}/argv.txt"`,
    '{',
    `  printf 'PATH=%s\\n' "$PATH"`,
    "  printf 'node_version='",
    '  node -v',
    "  printf 'node_abi='",
    "  node -p 'process.versions.modules'",
    "  printf 'node_execPath='",
    "  node -p 'process.execPath'",
    `} > "${recordDir}/facts.txt" 2>&1`,
    footer,
    ''
  ].join('\n')
  writeFileSync(join(binDir, 'pnpm'), body)
  chmodSync(join(binDir, 'pnpm'), 0o755)
}

/** Temp NVM layout whose exact-pin candidate resolves to a real node binary. */
function writeTempNvm(targetNode: string): string {
  const nvm = makeTempDir('dev-sync-nvm-')
  const binDir = join(nvm, 'versions', 'node', `v${pin}`, 'bin')
  mkdirSync(binDir, { recursive: true })
  symlinkSync(targetNode, join(binDir, 'node'))
  return nvm
}

/** Staged repo copy: the real run.sh + preflight bytes against temp pin files. */
function stageRepo(pinFiles: Record<string, string>): string {
  const root = makeTempDir('dev-sync-repo-')
  const dir = join(root, 'scripts', 'dev-sync')
  mkdirSync(dir, { recursive: true })
  copyFileSync(runSh, join(dir, 'run.sh'))
  copyFileSync(preflightJs, join(dir, 'runtime-preflight.js'))
  for (const [name, content] of Object.entries(pinFiles)) {
    writeFileSync(join(root, name), content)
  }
  return root
}

function parseArgv(recordDir: string): string[] {
  const text = readFileSync(join(recordDir, 'argv.txt'), 'utf8')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function parseFacts(recordDir: string): Record<string, string> {
  const facts: Record<string, string> = {}
  for (const line of readFileSync(join(recordDir, 'facts.txt'), 'utf8').split('\n')) {
    if (!line) continue
    const idx = line.indexOf('=')
    if (idx < 0) continue
    facts[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return facts
}

function withoutNvmDir(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.NVM_DIR
  return next
}

describe('dev:sync run.sh launcher', () => {
  it('is syntactically valid POSIX sh', () => {
    const result = spawnSync(SH, ['-n', runSh], { encoding: 'utf8' })
    expect(result.status).toBe(0)
  })

  it('keeps the narrow launcher contract in source', () => {
    const source = readFileSync(runSh, 'utf8')
    // Wires the existing preflight before the canonical lane, execs the lane verbatim.
    expect(source).toContain('scripts/dev-sync/runtime-preflight.js')
    expect(source).toContain('exec pnpm native:run electron -- tsx scripts/dev-sync/cli.ts')
    expect(source.indexOf('runtime-preflight.js')).toBeLessThan(source.indexOf('native:run electron'))
    expect(source).toContain('${1+"$@"}')
    // Exactly one exec: no second process owner, no daemon/wrapper lifecycle.
    expect(source.split('\n').filter((line) => line.startsWith('exec ')).length).toBe(1)
    // Reads pins, never sources them; nvm-dir aware without hardcoded user paths.
    expect(source).toContain('.nvmrc')
    expect(source).toContain('.node-version')
    expect(source).toContain('${NVM_DIR:-$HOME/.nvm}')
    // No version-override bypass, no toolchain download, no destructive ops.
    for (const forbidden of [
      'DEV_SYNC_',
      'OVERRIDE',
      'NODE_VERSION',
      'SKIP_',
      'FORCE_NODE',
      'nvm.sh',
      'fnm',
      'asdf',
      'curl',
      'wget',
      'uninstall'
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).not.toMatch(/^[^#]*\brm\s/m)
    expect(source).not.toMatch(/source\s/)
    expect(source).not.toContain('/Users/')
    expect(source).not.toContain('jorkey')
    // No dotfile writes and no background/daemon lifecycle (a lone `&`
    // operator; `&&`/`2>&1` redirections are ordinary shell, not lifecycle).
    for (const forbidden of ['.zshrc', '.bashrc', '.bash_profile']) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).not.toMatch(/(^|\s)&(\s|$)/m)
    expect(source).not.toMatch(/^\s*trap\s/m)
  })

  it('selects the installed exact pin from a Node22-like host with consistent descendant runtime', () => {
    const stubBin = makeTempDir('dev-sync-stub-')
    const recordDir = makeTempDir('dev-sync-record-')
    writeStubNode22(stubBin)
    writeStubPnpm(stubBin, recordDir, 'ok')
    const nvm = writeTempNvm(realPinNode)
    const homeSnapshot = readdirSync(join(home, '.nvm', 'versions', 'node'))
      .slice()
      .sort()
    const zshrc = join(home, '.zshrc')
    const zshrcMtime = existsSync(zshrc) ? statSync(zshrc).mtimeMs : null

    const result = spawnSync(SH, [runSh, '--', '--help'], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: nvm
      }
    })

    expect(result.status).toBe(0)
    expect(String(result.stdout ?? '')).toBe('')
    // Safe selection fact only: versions, never private full paths.
    expect(String(result.stderr ?? '')).toContain(`command-local Node v${pin} (ABI ${REQUIRED_ABI})`)
    expect(String(result.stderr ?? '')).toContain('v22.23.1')
    expect(String(result.stderr ?? '')).not.toContain(home)

    // Descendant PATH/process.execPath/ABI are consistent on the selected pin.
    const facts = parseFacts(recordDir)
    expect(facts['node_version']).toBe(`v${pin}`)
    expect(facts['node_abi']).toBe(REQUIRED_ABI)
    expect(String(facts['PATH'] ?? '').split(delimiter)[0]).toBe(join(nvm, 'versions', 'node', `v${pin}`, 'bin'))
    const execProbe = probeRealNode(String(facts['node_execPath'] ?? ''))
    expect(execProbe?.version).toBe(`v${pin}`)
    expect(execProbe?.abi).toBe(REQUIRED_ABI)

    // Lane command and args pass through verbatim (bare `--` kept for cli.ts to strip).
    expect(parseArgv(recordDir)).toEqual([
      'native:run',
      'electron',
      '--',
      'tsx',
      'scripts/dev-sync/cli.ts',
      '--',
      '--help'
    ])

    // No external dotfile/home-layout change.
    expect(
      readdirSync(join(home, '.nvm', 'versions', 'node'))
        .slice()
        .sort()
    ).toEqual(homeSnapshot)
    if (zshrcMtime !== null) expect(statSync(zshrc).mtimeMs).toBe(zshrcMtime)
  })

  it('uses the default nvm dir when NVM_DIR is unset', () => {
    // A temp HOME proves the `${NVM_DIR:-$HOME/.nvm}` default branch end to
    // end with a stub lane. The real default dir cannot be used here: it
    // ships its own pnpm, which the launcher's prepend must (correctly) prefer
    // over any PATH stub — and the real lane must never run in unit tests.
    const tempHome = makeTempDir('dev-sync-home-')
    const homeBin = join(tempHome, '.nvm', 'versions', 'node', `v${pin}`, 'bin')
    mkdirSync(homeBin, { recursive: true })
    symlinkSync(realPinNode, join(homeBin, 'node'))
    const stubBin = makeTempDir('dev-sync-stub-')
    const recordDir = makeTempDir('dev-sync-record-')
    writeStubNode22(stubBin)
    writeStubPnpm(stubBin, recordDir, 'ok')

    const result = spawnSync(SH, [runSh, '--', '--help'], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...withoutNvmDir(process.env),
        HOME: tempHome,
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`
      }
    })

    expect(result.status).toBe(0)
    const facts = parseFacts(recordDir)
    expect(facts['node_version']).toBe(`v${pin}`)
    expect(facts['node_abi']).toBe(REQUIRED_ABI)
    expect(String(facts['PATH'] ?? '').split(delimiter)[0]).toBe(homeBin)
  })

  it('keeps a supported current host when no pin is installed', () => {
    const currentBin = makeTempDir('dev-sync-current-')
    const recordDir = makeTempDir('dev-sync-record-')
    symlinkSync(realPinNode, join(currentBin, 'node'))
    writeStubPnpm(currentBin, recordDir, 'ok')
    const emptyNvm = makeTempDir('dev-sync-nvm-empty-')

    const result = spawnSync(SH, [runSh], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${currentBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: emptyNvm
      }
    })

    expect(result.status).toBe(0)
    const facts = parseFacts(recordDir)
    expect(facts['node_version']).toBe(`v${pin}`)
    expect(facts['node_abi']).toBe(REQUIRED_ABI)
    // No prepend happened: the supported current toolchain stays in place.
    expect(String(facts['PATH'] ?? '').split(delimiter)[0]).toBe(currentBin)
    expect(parseArgv(recordDir)).toEqual(['native:run', 'electron', '--', 'tsx', 'scripts/dev-sync/cli.ts'])
  })

  it('fails closed with no next step when the pin is missing and the host is unsupported', () => {
    const staged = stageRepo({})
    const stubBin = makeTempDir('dev-sync-stub-')
    const recordDir = makeTempDir('dev-sync-record-')
    writeStubNode22(stubBin)
    writeStubPnpm(stubBin, recordDir, 'marker')
    const emptyNvm = makeTempDir('dev-sync-nvm-empty-')

    const result = spawnSync(SH, [join(staged, 'scripts', 'dev-sync', 'run.sh')], {
      encoding: 'utf8',
      cwd: staged,
      env: {
        ...process.env,
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: emptyNvm
      }
    })

    expect(result.status).not.toBe(0)
    expect(String(result.stderr ?? '')).toContain('unreadable Node pin')
    expect(String(result.stderr ?? '')).not.toMatch(/token|secret|password|api[_-]?key/i)
    expect(existsSync(join(recordDir, 'marker'))).toBe(false)
    expect(existsSync(join(recordDir, 'argv.txt'))).toBe(false)
  })

  it('fails closed on an invalid pin without touching the lane', () => {
    const staged = stageRepo({ '.nvmrc': 'not-a-version\n', '.node-version': 'also-bad\n' })
    const stubBin = makeTempDir('dev-sync-stub-')
    const recordDir = makeTempDir('dev-sync-record-')
    writeStubNode22(stubBin)
    writeStubPnpm(stubBin, recordDir, 'marker')
    const emptyNvm = makeTempDir('dev-sync-nvm-empty-')

    const result = spawnSync(SH, [join(staged, 'scripts', 'dev-sync', 'run.sh')], {
      encoding: 'utf8',
      cwd: staged,
      env: {
        ...process.env,
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: emptyNvm
      }
    })

    expect(result.status).not.toBe(0)
    expect(String(result.stderr ?? '')).toContain('unreadable Node pin')
    expect(existsSync(join(recordDir, 'marker'))).toBe(false)
    expect(existsSync(join(recordDir, 'argv.txt'))).toBe(false)
  })

  it('rejects a wrong-version/ABI installed candidate and stays fail-closed on an unsupported host', () => {
    const stubBin = makeTempDir('dev-sync-stub-')
    const recordDir = makeTempDir('dev-sync-record-')
    writeStubNode22(stubBin)
    writeStubPnpm(stubBin, recordDir, 'marker')
    const nvm = writeTempNvm(wrongNodeBin)

    const result = spawnSync(SH, [runSh], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: nvm
      }
    })

    expect(result.status).not.toBe(0)
    expect(String(result.stderr ?? '')).toContain('no supported Node runtime')
    expect(existsSync(join(recordDir, 'marker'))).toBe(false)
    expect(existsSync(join(recordDir, 'argv.txt'))).toBe(false)
  })

  it('ignores a wrong installed candidate while a supported current host keeps working', () => {
    const currentBin = makeTempDir('dev-sync-current-')
    const recordDir = makeTempDir('dev-sync-record-')
    symlinkSync(realPinNode, join(currentBin, 'node'))
    writeStubPnpm(currentBin, recordDir, 'ok')
    const nvm = writeTempNvm(wrongNodeBin)

    const result = spawnSync(SH, [runSh], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${currentBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: nvm
      }
    })

    expect(result.status).toBe(0)
    const facts = parseFacts(recordDir)
    expect(facts['node_version']).toBe(`v${pin}`)
    expect(facts['node_abi']).toBe(REQUIRED_ABI)
    expect(String(facts['PATH'] ?? '').split(delimiter)[0]).toBe(currentBin)
  })

  it('passes the lane exit code through via exec with no swallowing', () => {
    const currentBin = makeTempDir('dev-sync-current-')
    const recordDir = makeTempDir('dev-sync-record-')
    symlinkSync(realPinNode, join(currentBin, 'node'))
    writeStubPnpm(currentBin, recordDir, 'exit42')
    const emptyNvm = makeTempDir('dev-sync-nvm-empty-')

    const result = spawnSync(SH, [runSh], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${currentBin}${delimiter}${process.env.PATH ?? ''}`,
        NVM_DIR: emptyNvm
      }
    })

    expect(result.status).toBe(42)
    // The stub stood in for the real Electron lane command.
    expect(parseArgv(recordDir)[0]).toBe('native:run')
  })
})
