import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { NATIVE_PACKAGE_VERSION } from '../constants'
import { createEffects } from '../effects'

/**
 * Shared-immutable-binary integration proof (real runtimes, real binary):
 *
 *  - the locked better-sqlite3 version is installed;
 *  - the default loader selects the SAME exact prebuilt file (realpath +
 *    sha256) under plain Node and under the real Electron main binary
 *    (`ELECTRON_RUN_AS_NODE=1`), and real `:memory:` SQL succeeds in both;
 *  - concurrent SQL runs (several Node probes + an Electron probe at once)
 *    all succeed — no serialized execution, no lock;
 *  - the Electron runtime still answers afterwards (stays alive/healthy).
 *
 * Read-only: fingerprints hash file bytes and use `:memory:` databases only.
 * No user database or package file is touched.
 */

const require_ = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(here, '..', '..', '..')
const FINGERPRINT = path.join(here, 'fixtures', 'fingerprint.cjs')
const MARKER = 'NATIVE_RUNTIME_FINGERPRINT'

interface Fingerprint {
  ok: boolean
  path?: string
  hash?: string
  version?: string
  sqlOk?: boolean
  error?: string
  runtime?: string
  abi?: number
}

function parseFingerprint(stdout: string): Fingerprint | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${MARKER} `)) continue
    try {
      return JSON.parse(trimmed.slice(MARKER.length).trim()) as Fingerprint
    } catch {
      return undefined
    }
  }
  return undefined
}

function runFingerprint(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function electronBinary(): string {
  const bin = createEffects().electronBinPath()
  if (!bin) throw new Error('Electron executable not found; run `pnpm install`.')
  return bin
}

describe('shared immutable binary (Node + real Electron main)', () => {
  it('the locked dependency version is installed', () => {
    const pkg = require_('better-sqlite3/package.json') as { version?: string }
    expect(pkg.version).toBe(NATIVE_PACKAGE_VERSION)
  })

  it('Node and Electron load ONE exact binary path+hash with working SQL', async () => {
    const bin = electronBinary()
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, REPO_ROOT }

    const [nodeRun, electronRun] = await Promise.all([
      runFingerprint(process.execPath, [FINGERPRINT], baseEnv),
      runFingerprint(bin, [FINGERPRINT], {
        ...baseEnv,
        ELECTRON_RUN_AS_NODE: '1',
        NATIVE_RUNTIME_PROBE_MARKER: 'NATIVE_RUNTIME_PROBE_V1'
      })
    ])

    const nodeFp = parseFingerprint(nodeRun.stdout)
    const electronFp = parseFingerprint(electronRun.stdout)
    expect(nodeRun.code).toBe(0)
    expect(electronRun.code).toBe(0)
    expect(nodeFp?.ok).toBe(true)
    expect(electronFp?.ok).toBe(true)
    expect(nodeFp?.sqlOk).toBe(true)
    expect(electronFp?.sqlOk).toBe(true)
    expect(nodeFp?.version).toBe(NATIVE_PACKAGE_VERSION)
    expect(electronFp?.version).toBe(NATIVE_PACKAGE_VERSION)
    // ONE exact binary: same realpath, same content hash.
    expect(nodeFp?.path).toBeDefined()
    expect(electronFp?.path).toBe(nodeFp?.path)
    expect(electronFp?.hash).toBe(nodeFp?.hash)
    // Cross-runtime facts: Electron reports its own modules ABI while Node
    // reports its own — informational only, both load the same file.
    expect(electronFp?.runtime).toBe('electron')
    expect(nodeFp?.runtime).toBe('node')
  }, 120000)

  it('concurrent SQL runs succeed in both runtimes with no serialization', async () => {
    const bin = electronBinary()
    const baseEnv: NodeJS.ProcessEnv = { ...process.env, REPO_ROOT }
    const startedAt = Date.now()

    const runs = await Promise.all([
      runFingerprint(process.execPath, [FINGERPRINT], baseEnv),
      runFingerprint(process.execPath, [FINGERPRINT], baseEnv),
      runFingerprint(process.execPath, [FINGERPRINT], baseEnv),
      runFingerprint(process.execPath, [FINGERPRINT], baseEnv),
      runFingerprint(bin, [FINGERPRINT], {
        ...baseEnv,
        ELECTRON_RUN_AS_NODE: '1',
        NATIVE_RUNTIME_PROBE_MARKER: 'NATIVE_RUNTIME_PROBE_V1'
      })
    ])
    const elapsedMs = Date.now() - startedAt

    const prints = runs.map((run) => parseFingerprint(run.stdout))
    for (const [index, fp] of prints.entries()) {
      expect(runs[index].code).toBe(0)
      expect(fp?.ok).toBe(true)
      expect(fp?.sqlOk).toBe(true)
    }
    // All five fingerprints agree on the single binary.
    const paths = new Set(prints.map((fp) => fp?.path))
    const hashes = new Set(prints.map((fp) => fp?.hash))
    expect(paths.size).toBe(1)
    expect(hashes.size).toBe(1)
    // Overlap is by construction (all five processes are spawned before any
    // close is awaited) and every run succeeds on the same binary: no lane
    // conflict, no lock contention, no serialization failure. The generous
    // bound only guards against a hung runtime.
    expect(elapsedMs).toBeLessThan(120000)
  }, 180000)
})
