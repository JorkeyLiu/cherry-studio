import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NATIVE_PACKAGE,
  PROBE_KILL_SIGNAL,
  PROBE_MARKER,
  PROBE_MARKER_ENV,
  PROBE_MODULE_ENV,
  PROBE_TEST_SEAM_ENV,
  PROBE_TIMEOUT_MS
} from './constants'
import type { Effects, ElectronProbeOutput, ProbeResult, SpawnResult } from './types'

/**
 * Real I/O wiring for the native runtime tool. All side effects are confined
 * here so the command logic (`check.ts`) stays deterministic and is
 * unit-testable with faithful fakes in the scripts Vitest project.
 *
 * Read-only by construction: nothing here writes to node_modules, user
 * databases, or package files. Probes use `:memory:` databases only.
 */

const require_ = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
export const PROBE_PATH = path.join(here, 'probe.cjs')

/** Minimal better-sqlite3 surface the in-process Node probe relies on. */
interface ProbeDatabase {
  prepare(sql: string): { get(): { ok: number } | undefined }
  close(): void
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function createEffects(): Effects {
  return {
    runtimeInfo: () => ({
      runtime: 'node',
      nodeVersion: process.versions.node,
      modulesAbi: Number(process.versions.modules),
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath
    }),
    readJson: (p) => JSON.parse(fs.readFileSync(p, 'utf8')) as unknown,
    realpath: (p) => fs.realpathSync(p),
    exists,
    resolvePackageJsonPath: (pkg) => {
      try {
        return require_.resolve(`${pkg}/package.json`)
      } catch {
        return undefined
      }
    },
    probeNodeBinding: () => {
      // The Database is always closed (finally) and both the primary probe
      // error and any close error are preserved; a failed close is a resource
      // leak and therefore a failed probe. In-process on every platform: the
      // shared Node-API binary is never switched, so no file-lock hazard.
      let db: ProbeDatabase | null = null
      let primaryError: string | undefined
      let closeError: string | undefined
      let sqlOk = false
      try {
        // Dynamic require from the tool's location walks up to the repo
        // node_modules and loads the same binary the app loads at runtime.
        const Database = require_(NATIVE_PACKAGE) as new (file: string) => ProbeDatabase
        db = new Database(':memory:')
        const row = db.prepare('select 1 as ok').get()
        sqlOk = !!(row && row.ok === 1)
        if (!sqlOk) {
          primaryError = 'SQL probe returned an unexpected row'
        }
      } catch (err) {
        primaryError = err instanceof Error ? err.message : String(err)
      } finally {
        if (db) {
          try {
            db.close()
          } catch (err) {
            closeError = err instanceof Error ? err.message : String(err)
          }
        }
      }
      if (primaryError || closeError) {
        return {
          ok: false,
          sqlOk: false,
          error: primaryError ?? `Database close failed: ${closeError}`,
          closeError: closeError || undefined
        }
      }
      return { ok: true, sqlOk: true }
    },
    electronBinPath: () => {
      try {
        // require('electron') returns the executable path when required from a
        // plain Node process.
        return require_('electron') as string
      } catch {
        return undefined
      }
    },
    electronVersion: () => {
      try {
        const pkg = require_('electron/package.json') as { version?: string }
        return pkg.version
      } catch {
        return undefined
      }
    },
    spawnElectronProbe: (bin, probePath, timeoutMs = PROBE_TIMEOUT_MS): SpawnResult => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        [PROBE_MARKER_ENV]: PROBE_MARKER
      }
      // The production probe proof can never be redirected by an inherited
      // environment. Delete the test stub module override AND the explicit
      // test-seam gate before spawning — the probe hardcodes the real
      // resolved package contract in production mode.
      delete env[PROBE_MODULE_ENV]
      delete env[PROBE_TEST_SEAM_ENV]
      // Bounded diagnostic probe: a hung Electron child is terminated after
      // PROBE_TIMEOUT_MS and fails closed as a probe failure (no retry).
      // spawnSync blocks the parent while the child runs, so a parent SIGINT
      // during the wait cannot forward until the child settles or the timeout
      // fires — that synchronous limitation is accepted and stays bounded by
      // the same timeout. No async process-lifecycle subsystem is built here.
      const res = spawnSync(bin, [probePath], {
        encoding: 'utf8',
        env,
        timeout: timeoutMs,
        killSignal: PROBE_KILL_SIGNAL
      })
      const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
      return {
        code: res.status ?? 1,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
        ...(timedOut ? { timedOut: true as const } : {})
      }
    },
    probePath: () => PROBE_PATH
  }
}

/**
 * Parse the probe JSON line emitted by `probe.cjs` from child stdout.
 * Shared by the Electron check and the runner's Electron probe.
 */
export function parseProbeOutput(stdout: string): ElectronProbeOutput | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(PROBE_MARKER)) {
      continue
    }
    const json = trimmed.slice(PROBE_MARKER.length).trim()
    try {
      return JSON.parse(json) as ElectronProbeOutput
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Spawn `probe.cjs` under plain Node as a child process and parse its output.
 * Used by tests that must not load the native binary in-process. Production
 * code paths use the in-process probe (`probeNodeBinding`) or the Electron
 * spawn (`spawnElectronProbe`) instead.
 */
export function spawnNodeProbe(
  probePath: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs: number = PROBE_TIMEOUT_MS
): ProbeResult & { raw: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PROBE_MARKER_ENV]: PROBE_MARKER,
    ...extraEnv
  }
  // Bounded diagnostic probe: same timeout/killSignal contract as the
  // Electron probe. A hung Node child is terminated and fails closed.
  const res = spawnSync(process.execPath, [probePath], {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    killSignal: PROBE_KILL_SIGNAL
  })
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    return {
      ok: false,
      sqlOk: false,
      error: `Node probe timed out after ${Math.round(timeoutMs / 1000)}s (bounded diagnostic timeout; child terminated, no retry)`,
      raw: res.stdout ?? ''
    }
  }
  const line = res.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(`${PROBE_MARKER} `))
  if (!line) {
    return {
      ok: false,
      sqlOk: false,
      error: `Node probe produced no parseable output (exit ${res.status ?? 1})`,
      raw: res.stdout
    }
  }
  try {
    const record = JSON.parse(line.slice(PROBE_MARKER.length).trim()) as {
      ok?: unknown
      sqlOk?: unknown
      error?: unknown
      closeError?: unknown
    }
    return {
      ok: record.ok === true,
      sqlOk: record.sqlOk === true,
      error: typeof record.error === 'string' ? record.error : undefined,
      closeError: typeof record.closeError === 'string' ? record.closeError : undefined,
      raw: res.stdout
    }
  } catch (error) {
    return {
      ok: false,
      sqlOk: false,
      error: `Node probe output was invalid: ${error instanceof Error ? error.message : String(error)}`,
      raw: res.stdout
    }
  }
}
