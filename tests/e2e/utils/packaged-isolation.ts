/**
 * Packaged-app isolation E2E helper (Phase C, LOCK-PLATFORM-005/LOCK-PROFILE-006).
 *
 * This helper launches the REAL packaged `Cherry Chat.app` binary
 * (`dist/mac-arm64/Cherry Chat.app/Contents/MacOS/Cherry Chat`) via Playwright
 * `_electron.launch({ executablePath })` against an exact disposable
 * `--user-data-dir=<token>` under an ownership-safe temp root, and verifies
 * runtime identity, empty first launch, same-profile single-instance behavior
 * and zero mutation of the real Cherry Studio / default Cherry Chat profiles.
 *
 * It deliberately does NOT reuse the dev fixture (whose Dev-suffix path
 * assumptions do not apply to packaged apps) and never invokes OS protocol
 * URLs, never copies into /Applications, and never uses broad pkill/killall —
 * cleanup is exact `--user-data-dir=<token>` process targeting only
 * (run-ownership / process-cleanup).
 *
 * Unavoidable packaged-runtime behaviors (observed, never invoked by the
 * test): the app's own `setAsDefaultProtocolClient` may register the running
 * package with Launch Services as normal app behavior, and the app's
 * `extractRtkBinaries()` writes its bundled rtk binary + `mcp` home dir into
 * the identity-specific home directory (`~/.cherrychat`) on first run. Neither
 * touches the Application Support profiles under test.
 */
import type { ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { validateOwnedRoot } from './run-ownership'

// ---------------------------------------------------------------------------
// Packaged executable resolution
// ---------------------------------------------------------------------------

/** Absolute path of the packaged Cherry Chat macOS arm64 executable. */
export function resolvePackagedExecutablePath(projectRoot: string): string {
  return path.join(projectRoot, 'dist', 'mac-arm64', 'Cherry Chat.app', 'Contents', 'MacOS', 'Cherry Chat')
}

/** Validate the packaged executable exists and is a real file. Throws otherwise. */
export function packagedExecutablePath(projectRoot = process.cwd()): string {
  const exePath = resolvePackagedExecutablePath(projectRoot)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(exePath)
  } catch {
    throw new Error(
      `Packaged Cherry Chat executable not found at ${exePath}. ` +
        'A fresh wrapped production build + `--dir` package is required first ' +
        '(pnpm build:unpack — the build-identity wrapper around ' +
        '`npm run build && electron-builder --dir`).'
    )
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Packaged Cherry Chat executable is not a regular file: ${exePath}`)
  }
  return exePath
}

// ---------------------------------------------------------------------------
// Launch surface (exact disposable profile token, ownership-safe env)
// ---------------------------------------------------------------------------

/** Exact launch args for the packaged binary (LOCK-625 token form). */
export function packagedLaunchArgs(userDataDir: string): string[] {
  return [`--user-data-dir=${userDataDir}`, '--no-sandbox', '--disable-gpu']
}

/** Launch env mirroring the owned-root TMPDIR convention (LOCK-001/002). */
export function packagedLaunchEnv(ownedTmpRoot: string): Record<string, string> {
  const canonicalRoot = validateOwnedRoot(ownedTmpRoot)
  return {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '',
    TMPDIR: canonicalRoot,
    TMP: canonicalRoot,
    TEMP: canonicalRoot
  }
}

/**
 * Launch the packaged Cherry Chat app via Playwright `_electron.launch`.
 * Returns the ElectronApplication; the caller MUST close it via exact-token
 * cleanup before the test ends.
 */
export function launchPackagedCherryChat(options: {
  executablePath: string
  userDataDir: string
  ownedTmpRoot: string
}): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: options.executablePath,
    args: packagedLaunchArgs(options.userDataDir),
    env: packagedLaunchEnv(options.ownedTmpRoot),
    timeout: 120000
  })
}

/**
 * Wait for the main Cherry Chat window and its React root. The window event
 * fires while the shared static HTML title (`Cherry Chat`) is still shown,
 * so an event-time title predicate can never observe the identity-derived
 * title — instead this waits for the FIRST window event (the main window) and
 * then polls the PAGE for the exact identity-derived title `Cherry Chat`
 * (LOCK-RETIRE-001). This is deterministic and never collides with the mini
 * window (`Cherry Chat Quick Assistant`, created after the main window).
 */
export async function waitForPackagedMainWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.waitForEvent('window', { timeout: 120000 })
  await page.waitForFunction(() => document.title === 'Cherry Chat', undefined, { timeout: 120000 })
  await page.waitForSelector('#root', { state: 'attached', timeout: 60000 })
  await page.waitForLoadState('domcontentloaded')
  return page
}

// ---------------------------------------------------------------------------
// Canonical path comparison (macOS /var → /private/var symlink resolution)
// ---------------------------------------------------------------------------

/**
 * True when two absolute paths refer to the same location. Compares the
 * canonicalized parent (realpath of the existing parent) plus the exact child
 * name — the same convention the dev fixture uses — falling back to a plain
 * resolved equality when the parents cannot be resolved.
 */
export function canonicalPathsEqual(actual: string, expected: string): boolean {
  if (actual === expected) return true
  try {
    const actualParent = fs.realpathSync(path.dirname(actual))
    const expectedParent = fs.realpathSync(path.dirname(expected))
    return actualParent === expectedParent && path.basename(actual) === path.basename(expected)
  } catch {
    return path.resolve(actual) === path.resolve(expected)
  }
}

// ---------------------------------------------------------------------------
// Bounded profile fingerprint (existence + immediate metadata only)
// ---------------------------------------------------------------------------

export interface FingerprintEntryStat {
  /** entry kind from lstat (never follows symlinks). */
  type: 'file' | 'directory' | 'symbolic-link' | 'other'
  /** st_mode (permission bits). */
  mode: number
  /** byte size. */
  size: number
  /** mtime in whole milliseconds (bounded, float-noise-free). */
  mtimeMs: number
}

export interface ProfileFingerprint {
  /** Whether the profile directory exists. */
  exists: boolean
  /** Bounded stat of the profile directory itself (null when absent). */
  stat: FingerprintEntryStat | null
  /**
   * Immediate-entry names + bounded stats, sorted by name. Directory mtime
   * changes when entries are added/removed, so this bounded snapshot detects
   * creation, deletion, or modification of immediate children without ever
   * reading file contents. No recursion, no markers, no writes.
   */
  entries: Array<{ name: string; stat: FingerprintEntryStat }> | null
}

function toFingerprintStat(stats: fs.Stats): FingerprintEntryStat {
  let type: FingerprintEntryStat['type']
  if (stats.isFile()) type = 'file'
  else if (stats.isDirectory()) type = 'directory'
  else if (stats.isSymbolicLink()) type = 'symbolic-link'
  else type = 'other'
  return { type, mode: stats.mode, size: stats.size, mtimeMs: Math.round(stats.mtimeMs) }
}

/**
 * Snapshot only existence plus a bounded metadata fingerprint of a profile
 * directory: the directory stat and its immediate-entry names/stats. Never
 * reads content, never creates markers, never writes anything.
 */
export function snapshotProfileFingerprint(profilePath: string): ProfileFingerprint {
  const resolved = path.resolve(profilePath)
  let dirStat: fs.Stats
  try {
    dirStat = fs.lstatSync(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, stat: null, entries: null }
    }
    throw error
  }
  const entries = fs
    .readdirSync(resolved)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ name, stat: toFingerprintStat(fs.lstatSync(path.join(resolved, name))) }))
  return { exists: true, stat: toFingerprintStat(dirStat), entries }
}

/** Deep structural equality of two profile fingerprints. */
export function profileFingerprintsEqual(before: ProfileFingerprint, after: ProfileFingerprint): boolean {
  if (before.exists !== after.exists) return false
  if (!before.exists) return true
  if (before.stat === null || after.stat === null) return before.stat === after.stat
  if (
    before.stat.type !== after.stat.type ||
    before.stat.mode !== after.stat.mode ||
    before.stat.size !== after.stat.size ||
    before.stat.mtimeMs !== after.stat.mtimeMs
  ) {
    return false
  }
  if (before.entries === null || after.entries === null) return before.entries === after.entries
  if (before.entries.length !== after.entries.length) return false
  for (let i = 0; i < before.entries.length; i++) {
    const b = before.entries[i]
    const a = after.entries[i]
    if (b.name !== a.name) return false
    if (
      b.stat.type !== a.stat.type ||
      b.stat.mode !== a.stat.mode ||
      b.stat.size !== a.stat.size ||
      b.stat.mtimeMs !== a.stat.mtimeMs
    ) {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Same-profile second-instance observation
// ---------------------------------------------------------------------------

export interface SecondInstanceResult {
  exitCode: number | null
  signal: string | null
  /** Whether the process exited within the bounded window. */
  exitedInTime: boolean
  elapsedMs: number
  spawnError: string | null
}

/**
 * Launch a SECOND instance of the packaged binary against the SAME exact
 * `--user-data-dir` token and observe its exit. The first instance holds the
 * single-instance lock for that profile, so the second instance must exit on
 * its own (requestSingleInstanceLock() fails → app.quit() + process.exit(0)).
 * The caller cleans up any stragglers via exact-token cleanup.
 */
export function launchSecondInstance(options: {
  executablePath: string
  userDataDir: string
  ownedTmpRoot: string
  timeoutMs?: number
}): Promise<SecondInstanceResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(options.executablePath, packagedLaunchArgs(options.userDataDir), {
      env: packagedLaunchEnv(options.ownedTmpRoot),
      stdio: 'ignore'
    })
    let settled = false
    const finish = (result: SecondInstanceResult): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    child.on('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        exitedInTime: false,
        elapsedMs: Date.now() - startedAt,
        spawnError: error.message
      })
    })
    child.on('exit', (code, signal) => {
      finish({
        exitCode: code,
        signal,
        exitedInTime: true,
        elapsedMs: Date.now() - startedAt,
        spawnError: null
      })
    })
    setTimeout(() => {
      // Bounded observation window closed — terminate ONLY this exact child.
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish({
        exitCode: null,
        signal: 'timeout',
        exitedInTime: false,
        elapsedMs: Date.now() - startedAt,
        spawnError: null
      })
    }, timeoutMs)
  })
}

// ---------------------------------------------------------------------------
// Real profile paths
// ---------------------------------------------------------------------------

/** `<homedir>/Library/Application Support` — the macOS app-data root. */
export function macAppDataRoot(homedir = os.homedir()): string {
  return path.join(homedir, 'Library', 'Application Support')
}

/** Real Cherry Studio default profile path (must never be touched). */
export function cherryStudioProfilePath(appDataRoot = macAppDataRoot()): string {
  return path.join(appDataRoot, 'Cherry Studio')
}

/**
 * The ACTUAL Electron-derived Cherry Studio default profile. Electron derives
 * `app.getPath('userData')` from the packaged app's package.json `name`
 * (`CherryStudio` — verified empirically: the packaged binary reports
 * `app.getName() === 'CherryStudio'` and the real profile lives here). This is
 * the profile a real Cherry Studio install uses, and Phase C must prove it is
 * not mutated. `cherryStudioProfilePath` (with a space) is the ADR
 * LOCK-PROFILE-006 guard form; both forms are fingerprinted.
 */
export function actualCherryStudioProfilePath(appDataRoot = macAppDataRoot()): string {
  return path.join(appDataRoot, 'CherryStudio')
}

/** Real Cherry Chat default profile path (must never be touched). */
export function defaultCherryChatProfilePath(appDataRoot = macAppDataRoot()): string {
  return path.join(appDataRoot, 'Cherry Chat')
}

/**
 * True when a path resolves to one of the real application profiles that
 * Phase C must never touch: the Cherry Studio default (both the ADR guard form
 * `Cherry Studio` and the actual Electron-derived `CherryStudio`) or the
 * default Cherry Chat profile `Cherry Chat`.
 */
export function isForbiddenProfilePath(profilePath: string, appDataRoot = macAppDataRoot()): boolean {
  return [
    cherryStudioProfilePath(appDataRoot),
    actualCherryStudioProfilePath(appDataRoot),
    defaultCherryChatProfilePath(appDataRoot)
  ].some((forbidden) => canonicalPathsEqual(profilePath, forbidden))
}
