/**
 * Native runtime cross-runtime contract (stable, focused).
 *
 * Proves the shared better-sqlite3 Node-API prebuilt binary is the ONE exact
 * binary (same realpath + sha256) under the Playwright Node runner and under
 * the real Electron main process, that real `:memory:` SQL succeeds in
 * overlapped use across both, and that the app stays responsive afterwards.
 *
 * Uses the shared fixture: fresh production build, disposable profile, mocked
 * external providers. Runs in final validation (not in focused unit work).
 */
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

// Runner-cwd anchored loader (same as tests/e2e/utils/sync-relay-process.ts):
// both Vitest and the Playwright runner execute at the repo root, and every
// other E2E spec loads as CJS. Using `import.meta.url` here would force this
// spec onto the ESM loader while the shared fixture closure stays CJS, so
// collection fails with `require is not defined in ES module scope`.
// Anchoring at `process.cwd()` keeps this spec on the same CJS loader.
function runnerRepoRoot(): string {
  const candidate = process.cwd()
  try {
    const stat = fs.lstatSync(candidate)
    if (stat.isDirectory() && !stat.isSymbolicLink() && fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate)
    }
  } catch {
    // fall through to the fail-closed error below
  }
  throw new Error('native-runtime.spec: cannot resolve repository root from runner cwd')
}

const repoRequire: NodeRequire = createRequire(path.join(runnerRepoRoot(), 'package.json'))

interface BindingFingerprint {
  ok: boolean
  path: string
  hash: string
  version: string
  sqlOk: boolean
  error?: string
}

/** Fingerprint the binary the way the production default loader selects it. */
function nodeFingerprint(): BindingFingerprint {
  const pkgPath = repoRequire.resolve('better-sqlite3/package.json') as unknown as string
  const root = path.dirname(pkgPath)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const binding = repoRequire(`${root}/lib/binding.js`) as { getPrebuildPath(): string | null }
  const candidate = binding.getPrebuildPath()
  if (!candidate) throw new Error('no prebuilt binary selected by the default loader')
  const real = fs.realpathSync(candidate)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = repoRequire('better-sqlite3') as new (
    file: string
  ) => {
    prepare(sql: string): { get(): { ok: number } | undefined }
    close(): void
  }
  const db = new Database(':memory:')
  try {
    const row = db.prepare('select 1 as ok').get()
    const sqlOk = !!row && row.ok === 1
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = repoRequire('better-sqlite3/package.json') as { version: string }
    return {
      ok: sqlOk,
      path: real,
      hash: createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
      version: pkg.version,
      sqlOk
    }
  } finally {
    db.close()
  }
}

const FINGERPRINT_MARKER = 'NATIVE_RUNTIME_FINGERPRINT'

/** Repo root for the owned fingerprint helper (no fixture mutation). */
function e2eRepoRoot(): string {
  return runnerRepoRoot()
}

function parseFingerprintStdout(stdout: string): BindingFingerprint | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${FINGERPRINT_MARKER} `)) continue
    try {
      return JSON.parse(trimmed.slice(FINGERPRINT_MARKER.length).trim()) as BindingFingerprint
    } catch {
      return undefined
    }
  }
  return undefined
}

interface OwnedFingerprintRun {
  promise: Promise<{ code: number | null; stdout: string; stderr: string }>
}

/**
 * Spawn one owned plain-Node fingerprint subprocess (`:memory:` SQL only).
 * The child handle is registered in `owned` so the test `finally` terminates
 * only owned workers — never a broad kill. The child env explicitly drops
 * `ELECTRON_RUN_AS_NODE` so the Node diagnostic can never be contaminated by
 * the Electron probe flag.
 */
function spawnOwnedNodeFingerprint(owned: ChildProcess[]): OwnedFingerprintRun {
  const repoRoot = e2eRepoRoot()
  const script = path.join(repoRoot, 'scripts', 'native-runtime', '__tests__', 'fixtures', 'fingerprint.cjs')
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_ROOT: repoRoot }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [script], { env })
  owned.push(child)
  const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
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
  return { promise }
}

test.describe('native runtime shared binary', () => {
  test('Node and Electron main load ONE exact binary with working SQL', async ({ electronApp, mainWindow }) => {
    await waitForAppReady(mainWindow)

    const nodeFp = nodeFingerprint()
    expect(nodeFp.ok).toBe(true)
    expect(nodeFp.sqlOk).toBe(true)
    expect(nodeFp.version).toBe('13.0.3')

    // Runs in the REAL Electron main process. Playwright passes the actual
    // electron module as the first arg — never globalThis.require (undefined in
    // the utility eval world). The loader is the TRUE app loader: createRequire
    // anchored at app.getAppPath(), so the default 13.0.3 driver resolves from
    // the actual app root. Self-contained (no closure capture, no import.meta).
    const electronFp = await electronApp.evaluate(({ app }) => {
      const proc = process as unknown as {
        getBuiltinModule?: (id: string) => unknown
      }
      const getBuiltin = proc.getBuiltinModule
      if (typeof getBuiltin !== 'function') {
        throw new Error('native-runtime.spec: process.getBuiltinModule is unavailable in the Electron main process')
      }
      const path = getBuiltin.call(proc, 'path') as typeof import('node:path')
      const fs = getBuiltin.call(proc, 'fs') as typeof import('node:fs')
      const crypto = getBuiltin.call(proc, 'crypto') as typeof import('node:crypto')
      const { createRequire } = getBuiltin.call(proc, 'module') as typeof import('node:module')
      const appRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
      const pkgPath = appRequire.resolve('better-sqlite3/package.json') as unknown as string
      const root = path.dirname(pkgPath)
      const binding = appRequire(path.join(root, 'lib', 'binding.js')) as {
        getPrebuildPath(): string | null
      }
      const candidate = binding.getPrebuildPath()
      if (!candidate) return { ok: false, error: 'no prebuilt binary selected' }
      const real = fs.realpathSync(candidate)
      const Database = appRequire('better-sqlite3') as new (
        file: string
      ) => {
        prepare(sql: string): { get(): { ok: number } | undefined }
        close(): void
      }
      const db = new Database(':memory:')
      try {
        const row = db.prepare('select 1 as ok').get()
        const sqlOk = !!row && row.ok === 1
        const pkg = appRequire(path.join(root, 'package.json')) as { version: string }
        return {
          ok: sqlOk,
          path: real,
          hash: crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex'),
          version: pkg.version,
          sqlOk
        }
      } finally {
        db.close()
      }
    })

    expect(electronFp.ok).toBe(true)
    expect(electronFp.sqlOk).toBe(true)
    // ONE exact binary shared across runtimes.
    expect(electronFp.path).toBe(nodeFp.path)
    expect(electronFp.hash).toBe(nodeFp.hash)
    expect(electronFp.version).toBe('13.0.3')
  })

  test('overlapped owned Node subprocess SQL alongside Electron main keeps the app responsive', async ({
    electronApp,
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)

    // Genuine owned Node subprocesses (plain Node, `:memory:` SQL only) plus
    // real Electron main work, overlapped by construction: every Node worker
    // is spawned before any close is awaited, and the Electron main evaluate
    // starts while the workers are still running. Bounded worker gate (3
    // Node workers) keeps the integrated contract fast.
    const owned: ChildProcess[] = []
    try {
      const workerRuns = [
        spawnOwnedNodeFingerprint(owned),
        spawnOwnedNodeFingerprint(owned),
        spawnOwnedNodeFingerprint(owned)
      ]
      expect(owned).toHaveLength(3)
      // Same true-app loader as above: actual electron module first arg, true
      // app-anchored require, :memory: SQL + close only.
      const electronWork = electronApp.evaluate(({ app }) => {
        const proc = process as unknown as {
          getBuiltinModule?: (id: string) => unknown
        }
        const getBuiltin = proc.getBuiltinModule
        if (typeof getBuiltin !== 'function') {
          throw new Error('native-runtime.spec: process.getBuiltinModule is unavailable in the Electron main process')
        }
        const path = getBuiltin.call(proc, 'path') as typeof import('node:path')
        const { createRequire } = getBuiltin.call(proc, 'module') as typeof import('node:module')
        const appRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
        const Database = appRequire('better-sqlite3') as new (
          file: string
        ) => {
          prepare(sql: string): { get(): { ok: number } | undefined }
          close(): void
        }
        const db = new Database(':memory:')
        try {
          const row = db.prepare('select 1 as ok').get()
          return { ok: !!row && row.ok === 1 }
        } finally {
          db.close()
        }
      })

      const [workerResults, electronResult] = await Promise.all([
        Promise.all(workerRuns.map((run) => run.promise)),
        electronWork
      ])
      const nodeFps: BindingFingerprint[] = []
      for (const result of workerResults) {
        expect(result.code).toBe(0)
        const fp = parseFingerprintStdout(result.stdout)
        expect(fp?.ok).toBe(true)
        expect(fp?.sqlOk).toBe(true)
        expect(fp?.version).toBe('13.0.3')
        // The helper reports plain Node (never Electron): no probe-flag leak.
        expect((fp as unknown as { runtime?: string }).runtime).toBe('node')
        if (fp) nodeFps.push(fp)
      }
      expect(nodeFps).toHaveLength(3)
      // All overlapped workers agree on the single shared binary.
      const paths = new Set(nodeFps.map((fp) => fp.path))
      const hashes = new Set(nodeFps.map((fp) => fp.hash))
      expect(paths.size).toBe(1)
      expect(hashes.size).toBe(1)
      expect(electronResult.ok).toBe(true)

      // The Electron app stays alive and responsive after the overlapped use.
      await waitForAppReady(mainWindow)
      const title = await mainWindow.title()
      expect(title).toBeTruthy()
    } finally {
      // Ownership-scoped cleanup only: terminate still-running owned workers.
      for (const child of owned) {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        } catch {
          // Ignore cleanup kill errors; the test assertions already settled.
        }
      }
    }
  })
})
