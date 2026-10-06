/**
 * Fixture path ownership for `pnpm dev:sync`.
 *
 * Durable dev-sync state lives under `<repo>/local/dev-sync` (the `local/`
 * prefix is already gitignored):
 *
 * - durable: the adopted persistent pair
 *   `sessions/<active-session>/` holding `profile-a`, `profile-b`, and
 *   `relay-data/` (relay DB + adjacent attachment blobs). The SAME pair is
 *   reused every run; the app itself persists chat, assets, providers,
 *   settings, device auth, channel, cursor, outbox, and relay state exactly
 *   like a normal close. The runner never clears, copies, renames, or deletes
 *   profile/relay data;
 * - pointer: `.dev-sync-active.json` records the one-time adopted existing
 *   session basename (relative only). A valid pointer is ALWAYS reused; a
 *   corrupted pointer or a missing/incomplete target fails closed;
 * - lock: `.dev-sync.lock` single-owner supervisor lock;
 * - reusable: `relay-runtime` isolated relay dependency cache;
 * - legacy (left untouched, never read): root-level `profile-a`,
 *   `profile-b`, `relay-data` (v1), `settings-a.json` / `settings-b.json`
 *   (retired seeds), and every non-adopted `sessions/<id>/` dir.
 *
 * These helpers resolve the root and per-session layouts and enforce the
 * isolation boundary before any child starts:
 *
 * - the root and every session/profile subpath must canonically contain
 *   inside the repository checkout (no escape, no symlink hop);
 * - profile dirs must never be a production user-data name and never resolve
 *   to a real home-config location — only the exact owned session paths
 *   identify reusable dev test data;
 * - the active pointer carries a session BASENAME only (never an absolute
 *   private path, never credentials) with strict kind/version validation;
 * - a second supervisor against the same fixture fails fast via the lock
 *   file (never kills the old owner).
 *
 * Pure where possible (realpath/containment take injectable fs seams) so the
 * contract is unit-testable without touching real profiles. Completeness
 * checks are metadata-only (existence + symlink kind): they never read file
 * content, profile config, seed JSON, provider keys, chat content, or DB
 * bytes/sizes.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  DEV_SYNC_ACTIVE_FILE,
  DEV_SYNC_ACTIVE_KIND,
  DEV_SYNC_ACTIVE_VERSION,
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
  DEV_SYNC_RELAY_DB_FILE,
  DEV_SYNC_RELAY_RUNTIME_DIR,
  DEV_SYNC_SESSIONS_DIR,
  DEV_SYNC_STABLE_SESSION_ID
} from './constants'

export interface DevSyncLayout {
  repoRoot: string
  root: string
  sessionsDir: string
  relayRuntimeDir: string
  lockFile: string
  fixtureFile: string
  activeFile: string
}

export interface DevSyncSessionLayout {
  id: string
  dir: string
  profileA: string
  profileB: string
  relayDataDir: string
  relayDb: string
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
    lockFile: join(root, DEV_SYNC_LOCK_FILE),
    fixtureFile: join(root, DEV_SYNC_FIXTURE_FILE),
    activeFile: join(root, DEV_SYNC_ACTIVE_FILE)
  }
}

/** Session ids are filesystem-safe, bounded, and unique per invocation. */
export function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(sessionId)
}

/**
 * Build a fresh unique ephemeral run id for one invocation (time + pid +
 * rand). The run id is for LOGS/OWNERSHIP ONLY and never decides the app
 * profile/relay dirs: profiles always come from the durable active pointer.
 */
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
 * Resolve the persistent per-session layout for an adopted session id.
 * Validates id shape, containment, symlink, and production-name guards.
 * Existence is NOT required here: completeness is checked separately via
 * `isCompleteSessionPair` so first-adoption and reuse share one resolver.
 * Never creates, copies, renames, or deletes anything.
 */
export function resolvePersistentSessionLayout(
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
  assertNoSymlinkOnPath(fs, join(relayDataDir, DEV_SYNC_RELAY_DB_FILE), layout.repoRoot, 'session relay DB')
  return { id: sessionId, dir, profileA, profileB, relayDataDir, relayDb: join(relayDataDir, DEV_SYNC_RELAY_DB_FILE) }
}

/**
 * Backwards-compatible alias for the retired fresh-session resolver.
 * Fresh per-run sessions no longer exist: this resolves the persistent
 * layout for an explicit session id (same validation, no freshness rule).
 * Prefer `resolvePersistentSessionLayout` for new code.
 */
export function resolveSessionLayout(
  layout: DevSyncLayout,
  sessionId: string,
  fs: FsSeam = nodeFsSeam
): DevSyncSessionLayout {
  return resolvePersistentSessionLayout(layout, sessionId, fs)
}

/**
 * Metadata-only completeness probe for one session pair. True only when
 * `profile-a/`, `profile-b/`, and `relay-data/relay.db` all exist and none
 * is a symlink. Reads NO file content (no profile config, no chat, no keys,
 * no DB bytes/sizes) — existence + link kind only.
 */
export function isCompleteSessionPair(session: DevSyncSessionLayout, fs: FsSeam = nodeFsSeam): boolean {
  for (const candidate of [session.profileA, session.profileB, session.relayDataDir, session.relayDb]) {
    try {
      if (!fs.existsSync(candidate)) return false
      if (fs.lstatSync(candidate).isSymbolicLink()) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * List candidate session basenames under the sessions dir, sorted ascending
 * (lexicographic order matches chronological `sess-<stamp>` order). Returns
 * [] when the dir is missing. Metadata-only (names only, no content read).
 * Root-legacy dirs are never listed: only `sessions/` is scanned.
 */
export function listSessionBasenames(sessionsDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(sessionsDir)
  } catch {
    return []
  }
  return entries.filter((entry) => isValidSessionId(entry)).sort()
}

export interface ActivePointer {
  kind: string
  version: number
  /** Adopted session BASENAME only (relative, never absolute, never secret). */
  session: string
  adoptedAt: string
}

function failActivePointer(what: string): never {
  throw new Error(`[dev-sync] refusing active pair pointer: ${what}`)
}

/**
 * Read + strictly validate the durable active-pair pointer. Returns null only
 * when the pointer file does not exist (first activation). Any present but
 * malformed pointer fails closed (never silently reset or re-chosen).
 * Metadata-only: validates shape/kind/version/basename, never reads profile
 * content.
 */
export function readActivePointer(activeFile: string): ActivePointer | null {
  if (!existsSync(activeFile)) return null
  let text: string
  try {
    text = readFileSync(activeFile, 'utf8')
  } catch {
    failActivePointer('unreadable pointer file')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text!)
  } catch {
    failActivePointer('malformed JSON (not parsed, not reset)')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failActivePointer('top-level is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.kind !== DEV_SYNC_ACTIVE_KIND) {
    failActivePointer(`unknown kind (${String(record.kind).slice(0, 64)})`)
  }
  if (record.version !== DEV_SYNC_ACTIVE_VERSION) {
    failActivePointer(`unknown version (${String(record.version).slice(0, 16)})`)
  }
  if (typeof record.session !== 'string' || !isValidSessionId(record.session)) {
    failActivePointer('session must be a valid session basename (relative only, never an absolute path)')
  }
  const session = record.session
  if (session.includes('/') || session.includes('\\')) {
    failActivePointer('session must be a bare basename (no path separators)')
  }
  if (typeof record.adoptedAt !== 'string' || record.adoptedAt.length === 0) {
    failActivePointer('adoptedAt must be a non-empty string')
  }
  return { kind: DEV_SYNC_ACTIVE_KIND, version: DEV_SYNC_ACTIVE_VERSION, session, adoptedAt: record.adoptedAt }
}

/**
 * Atomically publish the durable active-pair pointer (owner-only temp +
 * rename, mode 0600). Validates BEFORE any write. Value is the session
 * basename only — absolute private paths are refused.
 */
export function writeActivePointerAtomic(activeFile: string, sessionBasename: string): { file: string } {
  if (!isValidSessionId(sessionBasename) || sessionBasename.includes('/') || sessionBasename.includes('\\')) {
    throw new Error('[dev-sync] refusing active pair pointer: session must be a valid session basename')
  }
  const pointer: ActivePointer = {
    kind: DEV_SYNC_ACTIVE_KIND,
    version: DEV_SYNC_ACTIVE_VERSION,
    session: sessionBasename,
    adoptedAt: new Date().toISOString()
  }
  const text = `${JSON.stringify(pointer, null, 2)}\n`
  mkdirSync(dirname(activeFile), { recursive: true })
  const tmp = `${activeFile}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
    renameSync(tmp, activeFile)
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best effort temp cleanup.
    }
    throw new Error('[dev-sync] failed to publish the active pair pointer')
  }
  try {
    chmodSync(activeFile, 0o600)
  } catch {
    // Best effort: the atomic rename already published owner-only bytes.
  }
  return { file: activeFile }
}

export interface AdoptedSession {
  session: DevSyncSessionLayout
  /** True when this call created the stable pair / adopted the pointer. */
  created: boolean
  /** True when a valid existing pointer was reused (never re-chosen). */
  reused: boolean
}

/**
 * Resolve the ONE durable session pair for this fixture.
 *
 * - A valid existing pointer is ALWAYS reused (even when newer complete
 *   sessions exist elsewhere in metadata): the target must validate
 *   (containment/symlink) and be a complete pair, else fail closed.
 * - With NO pointer and existing complete pairs: adopt the LATEST complete
 *   initialized pair (lexicographically greatest basename) and record the
 *   pointer. Existing but all-incomplete sessions fail closed (partial run
 *   data is never discarded for a silent fresh empty pair).
 * - With NO pointer and NO sessions: create ONE stable pair
 *   (`sess-persistent-pair-v1` dirs) and record the pointer; later runs reuse
 *   it (never fresh).
 * - Root-legacy v1 dirs are never scanned, adopted, or migrated here.
 *
 * Only metadata (names/existence/link kind) is inspected; no profile/seed/
 * chat/DB content is ever read. On adoption/creation the pointer file is the
 * ONLY metadata write (plus the stable pair dirs on a clean fixture).
 */
export function resolveActiveSessionLayout(layout: DevSyncLayout, fs: FsSeam = nodeFsSeam): AdoptedSession {
  const pointer = readActivePointer(layout.activeFile)
  if (pointer) {
    const session = resolvePersistentSessionLayout(layout, pointer.session, fs)
    if (!isCompleteSessionPair(session, fs)) {
      throw new Error(
        `[dev-sync] refusing active pair pointer: adopted session is incomplete or missing ` +
          `(${pointer.session}); refusing to silently reset or choose another pair`
      )
    }
    return { session, created: false, reused: true }
  }

  const basenames = listSessionBasenames(layout.sessionsDir)
  if (basenames.length > 0) {
    const complete: string[] = []
    for (const basenameEntry of basenames) {
      let session: DevSyncSessionLayout
      try {
        session = resolvePersistentSessionLayout(layout, basenameEntry, fs)
      } catch {
        continue
      }
      if (isCompleteSessionPair(session, fs)) complete.push(basenameEntry)
    }
    if (complete.length === 0) {
      throw new Error(
        '[dev-sync] refusing session adoption: existing sessions found but none is a complete ' +
          'initialized pair (profile-a + profile-b + relay DB); refusing to silently start a fresh ' +
          'empty pair over existing data'
      )
    }
    complete.sort()
    const latest = complete[complete.length - 1]
    writeActivePointerAtomic(layout.activeFile, latest)
    return { session: resolvePersistentSessionLayout(layout, latest, fs), created: true, reused: false }
  }

  // Clean fixture: create ONE stable pair for initial use; later runs reuse it.
  // The relay DB placeholder is zero bytes (the relay opens it as an empty
  // database on first boot and runs its own migrations); no profile, seed,
  // chat, or credential content is fabricated.
  const stable = resolvePersistentSessionLayout(layout, DEV_SYNC_STABLE_SESSION_ID, fs)
  mkdirSync(stable.profileA, { recursive: true })
  mkdirSync(stable.profileB, { recursive: true })
  mkdirSync(stable.relayDataDir, { recursive: true })
  if (!existsSync(stable.relayDb)) writeFileSync(stable.relayDb, Buffer.alloc(0))
  writeActivePointerAtomic(layout.activeFile, stable.id)
  return { session: stable, created: true, reused: false }
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
