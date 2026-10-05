/**
 * Fixture path ownership for `pnpm dev:sync`.
 *
 * Durable dev-sync state lives under `<repo>/local/dev-sync` (the `local/`
 * prefix is already gitignored):
 *
 * - durable: fixture marker, supervisor lock, owner-only settings seeds
 *   (`settings-a.json` / `settings-b.json`), reusable relay-runtime cache;
 * - fresh per run: `sessions/<session-id>/` holding `profile-a`, `profile-b`,
 *   and `relay-data/` (relay DB + adjacent attachment blobs);
 * - legacy v1: root-level `profile-a`, `profile-b`, `relay-data` are
 *   preserved as-is — never read, copied, or deleted by the runner.
 *
 * These helpers resolve the root and per-session layouts and enforce the
 * isolation boundary before any child starts:
 *
 * - the root and every session/profile subpath must canonically contain
 *   inside the repository checkout (no escape, no symlink hop);
 * - profile dirs must never be a production user-data name and never resolve
 *   to a real home-config location — only the exact owned fixture marker
 *   identifies reusable dev test data;
 * - a session dir must be fresh (must not already exist) so a new DB can
 *   never replay previous content;
 * - a second supervisor against the same fixture fails fast via the lock
 *   file (never kills the old owner).
 *
 * Pure where possible (realpath/containment take injectable fs seams) so the
 * contract is unit-testable without touching real profiles.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  DEV_SYNC_DIR_NAME,
  DEV_SYNC_FIXTURE_FILE,
  DEV_SYNC_FIXTURE_KIND,
  DEV_SYNC_FIXTURE_VERSION,
  DEV_SYNC_FORBIDDEN_BASENAMES,
  DEV_SYNC_LEGACY_FIXTURE_KIND,
  DEV_SYNC_LEGACY_FIXTURE_VERSION,
  DEV_SYNC_LOCK_FILE,
  DEV_SYNC_PROFILE_A,
  DEV_SYNC_PROFILE_B,
  DEV_SYNC_RELAY_DATA_DIR,
  DEV_SYNC_RELAY_RUNTIME_DIR,
  DEV_SYNC_SESSIONS_DIR,
  DEV_SYNC_SETTINGS_SEED_A_FILE,
  DEV_SYNC_SETTINGS_SEED_B_FILE
} from './constants'

export interface DevSyncLayout {
  repoRoot: string
  root: string
  sessionsDir: string
  relayRuntimeDir: string
  settingsSeedA: string
  settingsSeedB: string
  lockFile: string
  fixtureFile: string
}

export interface DevSyncSessionLayout {
  id: string
  dir: string
  profileA: string
  profileB: string
  relayDataDir: string
}

export interface FsSeam {
  existsSync: (p: string) => boolean
  lstatSync: (p: string) => { isSymbolicLink: () => boolean }
  realpathSync: (p: string) => string
}

export const nodeFsSeam: FsSeam = { existsSync, lstatSync, realpathSync }

function canonicalParentChild(parentReal: string, childReal: string): boolean {
  return childReal === parentReal || childReal.startsWith(`${parentReal}/`)
}

function assertNoSymlinkOnPath(fs: FsSeam, absolutePath: string, repoReal: string, label: string): string {
  // Walk every existing ancestor from the repo root down: any symlink in the
  // chain fails closed so a link can never redirect the fixture at live data.
  const targetReal = fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : absolutePath
  let cursor = absolutePath
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`[dev-sync] refusing ${label}: path component is a symlink (${cursor})`)
    }
    if (cursor === repoReal || dirname(cursor) === cursor) break
    cursor = dirname(cursor)
    if (!canonicalParentChild(repoReal, cursor) && cursor !== repoReal) break
  }
  return targetReal
}

function assertOwnedSubpath(repoReal: string, candidate: string, label: string): void {
  const base = basename(candidate)
  const lowered = base.toLowerCase()
  for (const forbidden of DEV_SYNC_FORBIDDEN_BASENAMES) {
    if (lowered === forbidden.toLowerCase()) {
      throw new Error(`[dev-sync] refusing ${label}: production user-data name (${base})`)
    }
  }
  if (!canonicalParentChild(repoReal, candidate)) {
    throw new Error(`[dev-sync] refusing ${label}: escapes the repository checkout (${candidate})`)
  }
}

/**
 * Resolve the fixture layout for a repository checkout root and validate the
 * isolation boundary. Throws fail-closed on any violation. Never touches
 * production user-data names. Legacy v1 profile/relay dirs at the root are
 * NOT part of the layout and are never created here.
 */
export function resolveDevSyncLayout(repoRoot: string, fs: FsSeam = nodeFsSeam): DevSyncLayout {
  const repoReal = fs.realpathSync(resolve(repoRoot))
  const root = join(repoReal, 'local', DEV_SYNC_DIR_NAME)

  assertOwnedSubpath(repoReal, root, 'fixture root')
  assertNoSymlinkOnPath(fs, root, repoReal, 'fixture root')

  return {
    repoRoot: repoReal,
    root,
    sessionsDir: join(root, DEV_SYNC_SESSIONS_DIR),
    relayRuntimeDir: join(root, DEV_SYNC_RELAY_RUNTIME_DIR),
    settingsSeedA: join(root, DEV_SYNC_SETTINGS_SEED_A_FILE),
    settingsSeedB: join(root, DEV_SYNC_SETTINGS_SEED_B_FILE),
    lockFile: join(root, DEV_SYNC_LOCK_FILE),
    fixtureFile: join(root, DEV_SYNC_FIXTURE_FILE)
  }
}

/** Session ids are filesystem-safe, bounded, and unique per invocation. */
export function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(sessionId)
}

/** Build a fresh unique session id for one invocation (time + pid + rand). */
export function createSessionId(
  now: Date = new Date(),
  pid: number = process.pid,
  randHex: string | null = null
): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const rand = (randHex ?? Math.floor(Math.random() * 0xffffff).toString(16)).padStart(6, '0').slice(0, 6)
  return `sess-${stamp}-${pid}-${rand}`
}

/**
 * Resolve the per-session layout for a fresh session id. The session dir
 * must NOT already exist (fail-closed: a new DB must never replay previous
 * content). Session profile/relay subpaths get the same containment,
 * symlink, and production-name checks as the fixture root.
 */
export function resolveSessionLayout(
  layout: DevSyncLayout,
  sessionId: string,
  fs: FsSeam = nodeFsSeam
): DevSyncSessionLayout {
  if (!isValidSessionId(sessionId)) {
    throw new Error('[dev-sync] refusing session: invalid session id (expected [A-Za-z0-9-], <=64 chars)')
  }
  const dir = join(layout.sessionsDir, sessionId)
  assertOwnedSubpath(layout.repoRoot, dir, 'session dir')
  assertNoSymlinkOnPath(fs, dir, layout.repoRoot, 'session dir')
  if (fs.existsSync(dir)) {
    throw new Error(`[dev-sync] refusing session: session dir already exists (${dir}); refusing to replay old content`)
  }
  const profileA = join(dir, DEV_SYNC_PROFILE_A)
  const profileB = join(dir, DEV_SYNC_PROFILE_B)
  const relayDataDir = join(dir, DEV_SYNC_RELAY_DATA_DIR)
  for (const [candidate, label] of [
    [profileA, 'session profile-a'],
    [profileB, 'session profile-b'],
    [relayDataDir, 'session relay-data']
  ] as const) {
    assertOwnedSubpath(layout.repoRoot, candidate, label)
  }
  assertNoSymlinkOnPath(fs, profileA, layout.repoRoot, 'session profile-a')
  assertNoSymlinkOnPath(fs, profileB, layout.repoRoot, 'session profile-b')
  return { id: sessionId, dir, profileA, profileB, relayDataDir }
}

export interface FixtureMarker {
  kind: string
  version: number
  createdAt: string
}

/**
 * Ensure the owned fixture marker. Creates it once; reuses it when it
 * identifies our fixture version; migrates the legacy v1 persistent-profiles
 * marker in place (old profile/relay dirs stay on disk, unused); fails
 * closed when the directory carries an unknown marker (never reinterprets
 * foreign state as dev test data).
 */
export function ensureFixtureMarker(fixtureFile: string): { created: boolean; migrated: boolean } {
  if (!existsSync(fixtureFile)) {
    mkdirSync(dirname(fixtureFile), { recursive: true })
    const marker: FixtureMarker = {
      kind: DEV_SYNC_FIXTURE_KIND,
      version: DEV_SYNC_FIXTURE_VERSION,
      createdAt: new Date().toISOString()
    }
    writeFileSync(fixtureFile, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
    return { created: true, migrated: false }
  }
  let parsed: FixtureMarker
  try {
    parsed = JSON.parse(readFileSync(fixtureFile, 'utf8')) as FixtureMarker
  } catch {
    throw new Error(`[dev-sync] refusing fixture root: unreadable marker (${fixtureFile})`)
  }
  if (parsed?.kind === DEV_SYNC_FIXTURE_KIND && parsed?.version === DEV_SYNC_FIXTURE_VERSION) {
    return { created: false, migrated: false }
  }
  if (parsed?.kind === DEV_SYNC_LEGACY_FIXTURE_KIND && parsed?.version === DEV_SYNC_LEGACY_FIXTURE_VERSION) {
    // In-place migration: only the marker is rewritten. Legacy v1
    // profile/relay dirs (if any) stay on disk untouched and unused; the
    // first runs start from default config until new seeds are captured.
    const migrated: FixtureMarker = {
      kind: DEV_SYNC_FIXTURE_KIND,
      version: DEV_SYNC_FIXTURE_VERSION,
      createdAt: new Date().toISOString()
    }
    writeFileSync(fixtureFile, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 })
    return { created: false, migrated: true }
  }
  throw new Error(
    `[dev-sync] refusing fixture root: unknown marker kind/version ` +
      `(${String(parsed?.kind)}/${String(parsed?.version)}); remove it manually if this directory is truly disposable`
  )
}

export interface SupervisorLock {
  pid: number
  startedAt: string
}

export function readSupervisorLock(lockFile: string): SupervisorLock | null {
  if (!existsSync(lockFile)) return null
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as SupervisorLock
    if (!Number.isSafeInteger(parsed?.pid) || parsed.pid <= 0) return null
    return parsed
  } catch {
    return null
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Acquire the per-fixture supervisor lock. A live owner fails fast (never
 * kills the old owner); a stale lock is reclaimed. Returns a release closure
 * that removes the lock only when it still owns it.
 */
export function acquireSupervisorLock(
  lockFile: string,
  isAlive: (pid: number) => boolean = isPidAlive
): { release: () => void } {
  const existing = readSupervisorLock(lockFile)
  if (existing && isAlive(existing.pid)) {
    throw new Error(
      `[dev-sync] another dev:sync supervisor owns this fixture (pid ${existing.pid}); ` +
        `stop it first (Ctrl-C in its terminal). Refusing to start a duplicate session.`
    )
  }
  mkdirSync(dirname(lockFile), { recursive: true })
  const own: SupervisorLock = { pid: process.pid, startedAt: new Date().toISOString() }
  writeFileSync(lockFile, `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 })
  return {
    release: () => {
      try {
        const current = readSupervisorLock(lockFile)
        if (current && current.pid === process.pid) rmSync(lockFile, { force: true })
      } catch {
        // Best effort: the lock file is advisory; a stale file fails the
        // next start closed only when its pid is alive.
      }
    }
  }
}
