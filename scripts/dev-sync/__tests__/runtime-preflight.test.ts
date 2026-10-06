import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, '..', 'runtime-preflight.js')
const repoRoot = join(here, '..', '..', '..')

const require = createRequire(import.meta.url)
const preflight = require('../runtime-preflight.js') as {
  parseSemver: (raw: unknown) => { major: number; minor: number; patch: number; text: string } | null
  compareSemver: (
    a: { major: number; minor: number; patch: number },
    b: { major: number; minor: number; patch: number }
  ) => number
  readRequiredVersion: (repoRoot: string) => { ok: true; version: string } | { ok: false }
  isSupportedVersion: (observations: {
    version: string
    abi: string
    requiredVersion: string
    requiredAbi: string
  }) => boolean
}

let owned: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-sync-preflight-'))
  owned.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true })
  owned = []
})

/** Test-only `-r` preload fixture: fakes the runtime BEFORE the real entrypoint runs. */
function writeVersionFixture(version: string, abi: string): string {
  const dir = makeTempDir()
  const fixture = join(dir, 'fake-version.cjs')
  const body = [
    "'use strict';",
    `Object.defineProperty(process, 'version', { value: ${JSON.stringify(version)}, configurable: true });`,
    'try {',
    `  Object.defineProperty(process.versions, 'modules', { value: ${JSON.stringify(abi)}, configurable: true });`,
    '} catch (e) {',
    `  process.versions.modules = ${JSON.stringify(abi)};`,
    '}',
    ''
  ].join('\n')
  writeFileSync(fixture, body)
  return fixture
}

function runEntry(extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...extraArgs, scriptPath], { encoding: 'utf8' })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

function runEntryWithFakeRuntime(
  version: string,
  abi: string
): { status: number | null; stdout: string; stderr: string } {
  const fixture = writeVersionFixture(version, abi)
  return runEntry(['-r', fixture])
}

describe('dev:sync runtime preflight validators (pure unit)', () => {
  it('parses pinned versions and orders them without drift', () => {
    expect(preflight.parseSemver('24.11.1')?.text).toBe('24.11.1')
    expect(preflight.parseSemver('  v24.11.1\n')?.text).toBe('24.11.1')
    expect(preflight.parseSemver('garbage')).toBeNull()
    expect(preflight.parseSemver('24.11')).toBeNull()
    const atLeast = preflight.parseSemver('24.11.1')!
    const below = preflight.parseSemver('24.10.0')!
    expect(preflight.compareSemver(below, atLeast)).toBeLessThan(0)
    expect(preflight.compareSemver(atLeast, atLeast)).toBe(0)
  })

  it('gates on same-major, >= pin, and exact Node 24 lane ABI', () => {
    const required = { requiredVersion: '24.11.1', requiredAbi: '137' }
    expect(preflight.isSupportedVersion({ version: 'v24.11.1', abi: '137', ...required })).toBe(true)
    expect(preflight.isSupportedVersion({ version: 'v24.12.0', abi: '137', ...required })).toBe(true)
    expect(preflight.isSupportedVersion({ version: 'v22.23.1', abi: '127', ...required })).toBe(false)
    expect(preflight.isSupportedVersion({ version: 'v24.10.0', abi: '137', ...required })).toBe(false)
    expect(preflight.isSupportedVersion({ version: 'v25.0.0', abi: '137', ...required })).toBe(false)
    expect(preflight.isSupportedVersion({ version: 'v24.11.1', abi: '127', ...required })).toBe(false)
    expect(preflight.isSupportedVersion({ version: 'garbage', abi: '137', ...required })).toBe(false)
  })

  it('fails the pin closed instead of silently falling back', () => {
    const okDir = makeTempDir()
    writeFileSync(join(okDir, '.nvmrc'), '24.11.1\n')
    expect(preflight.readRequiredVersion(okDir)).toEqual({ ok: true, version: '24.11.1' })

    const fallbackDir = makeTempDir()
    writeFileSync(join(fallbackDir, '.node-version'), 'v24.11.1\n')
    expect(preflight.readRequiredVersion(fallbackDir)).toEqual({ ok: true, version: '24.11.1' })

    const missingDir = makeTempDir()
    expect(preflight.readRequiredVersion(missingDir)).toEqual({ ok: false })

    const invalidDir = makeTempDir()
    writeFileSync(join(invalidDir, '.nvmrc'), 'not-a-version\n')
    writeFileSync(join(invalidDir, '.node-version'), 'also-bad\n')
    expect(preflight.readRequiredVersion(invalidDir)).toEqual({ ok: false })
  })
})

describe('dev:sync runtime preflight entrypoint (real subprocess)', () => {
  it('passes on the supported pinned runtime without side-effect output', () => {
    const result = runEntry()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('rejects the reported host Node22/ABI127 with actionable version diagnostics', () => {
    const result = runEntryWithFakeRuntime('v22.23.1', '127')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('v22.23.1')
    expect(result.stderr).toContain('ABI 127')
    expect(result.stderr).toContain('24.11.1')
    expect(result.stderr).toContain('ABI 137')
    expect(result.stderr).toContain('which -a node')
    expect(result.stderr).toContain('export PATH="$HOME/.nvm/versions/node/v24.11.1/bin:$PATH"')
    expect(result.stderr).toContain('node -v')
    expect(result.stderr).toContain('pnpm -v')
    // Fail-closed without touching secrets, profiles, or cache-deletion claims.
    expect(result.stderr).not.toMatch(/token|secret|password|api[_-]?key/i)
    expect(result.stderr).not.toMatch(/settings-a\.json|settings-b\.json/)
    expect(result.stderr.toLowerCase()).not.toContain('delete the cache')
    expect(result.stderr.toLowerCase()).not.toContain('remove the cache')
  })

  it('rejects below the 24.11.1 patch floor even when the ABI matches', () => {
    const result = runEntryWithFakeRuntime('v24.10.0', '137')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('v24.10.0')
    expect(result.stderr).toContain('24.11.1')
  })

  it('rejects other majors and ABI mismatches on the supported line', () => {
    const otherMajor = runEntryWithFakeRuntime('v25.0.0', '137')
    expect(otherMajor.status).toBe(1)
    expect(otherMajor.stderr).toContain('v25.0.0')

    const abiMismatch = runEntryWithFakeRuntime('v24.11.1', '127')
    expect(abiMismatch.status).toBe(1)
    expect(abiMismatch.stderr).toContain('ABI 127')
  })

  it('fails early: a rejected preflight never runs the chained next step', () => {
    const fixture = writeVersionFixture('v22.23.1', '127')
    const failing = spawnSync(
      `${JSON.stringify(process.execPath)} -r ${JSON.stringify(fixture)} ${JSON.stringify(scriptPath)} && ${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('SHOULD_NOT_RUN')")}`,
      { encoding: 'utf8', shell: '/bin/sh' }
    )
    expect(failing.status).not.toBe(0)
    expect(String(failing.stdout ?? '')).not.toContain('SHOULD_NOT_RUN')

    const passing = spawnSync(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} && ${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('PREFLIGHT_GATE_OPEN')")}`,
      { encoding: 'utf8', shell: '/bin/sh' }
    )
    expect(passing.status).toBe(0)
    expect(String(passing.stdout ?? '')).toContain('PREFLIGHT_GATE_OPEN')
  })

  it('wires the public dev:sync entry through the command-local launcher before the canonical lane, with no production bypass', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const entry = manifest.scripts['dev:sync']
    // Command-local auto-select: the package entry is only the POSIX launcher,
    // which selects the installed pinned Node for this command before the lane.
    expect(entry).toBe('sh scripts/dev-sync/run.sh')
    expect(entry).not.toContain('DEV_SYNC_PREFLIGHT')

    // The launcher itself runs the existing preflight before the canonical
    // lane and execs the lane verbatim, with no version-override bypass and
    // no shell-init/user-default/install side effects.
    const launcher = readFileSync(join(repoRoot, 'scripts', 'dev-sync', 'run.sh'), 'utf8')
    expect(launcher).toContain('scripts/dev-sync/runtime-preflight.js')
    expect(launcher).toContain('exec pnpm native:run electron -- tsx scripts/dev-sync/cli.ts')
    expect(launcher.indexOf('runtime-preflight.js')).toBeLessThan(launcher.indexOf('native:run electron'))
    expect(launcher).not.toContain('DEV_SYNC_PREFLIGHT')
    expect(launcher).not.toContain('OVERRIDE')
    expect(launcher).not.toContain('nvm.sh')

    const source = readFileSync(scriptPath, 'utf8')
    expect(source).not.toContain('DEV_SYNC_PREFLIGHT')
    expect(source).not.toContain('OVERRIDE')
    expect(source).not.toContain('process.env')
    expect(source).toContain('process.version')
    expect(source).toContain('process.versions.modules')
  })
})
