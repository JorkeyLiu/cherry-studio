import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEV_SYNC_ACTIVE_KIND,
  DEV_SYNC_ACTIVE_VERSION,
  DEV_SYNC_FIXTURE_KIND,
  DEV_SYNC_FIXTURE_VERSION,
  DEV_SYNC_LEGACY_FIXTURE_KIND,
  DEV_SYNC_LEGACY_FIXTURE_VERSION,
  DEV_SYNC_STABLE_SESSION_ID
} from '../constants'
import {
  acquireSupervisorLock,
  createSessionId,
  ensureFixtureMarker,
  isCompleteSessionPair,
  isValidSessionId,
  listSessionBasenames,
  readActivePointer,
  readSupervisorLock,
  resolveActiveSessionLayout,
  resolveDevSyncLayout,
  resolvePersistentSessionLayout,
  writeActivePointerAtomic
} from '../paths'

let owned: string[] = []

function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dev-sync-paths-'))
  owned.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true })
  owned = []
})

/** Metadata-only complete pair: dirs + empty relay DB file (existence only). */
function makeCompletePair(layout: ReturnType<typeof resolveDevSyncLayout>, sessionId: string): void {
  const session = resolvePersistentSessionLayout(layout, sessionId)
  mkdirSync(session.profileA, { recursive: true })
  mkdirSync(session.profileB, { recursive: true })
  mkdirSync(session.relayDataDir, { recursive: true })
  writeFileSync(session.relayDb, 'synthetic-marker-bytes')
}

describe('resolveDevSyncLayout', () => {
  it('resolves the durable fixture paths with an active-pair pointer (no seed paths)', () => {
    const layout = resolveDevSyncLayout(makeRepoRoot())
    expect(layout.root.endsWith(join('local', 'dev-sync'))).toBe(true)
    expect(layout.sessionsDir).toBe(join(layout.root, 'sessions'))
    expect(layout.activeFile).toBe(join(layout.root, '.dev-sync-active.json'))
    expect(layout.lockFile).toBe(join(layout.root, '.dev-sync.lock'))
    // No settings-seed paths: the runner performs no seed restore/snapshot.
    expect('settingsSeedA' in layout).toBe(false)
    expect('settingsSeedB' in layout).toBe(false)
    // No persistent profile-a/profile-b at the root: the adopted pair owns profiles.
    expect('profileA' in layout).toBe(false)
    expect('profileB' in layout).toBe(false)
  })

  it('refuses a symlinked fixture root', () => {
    const repo = makeRepoRoot()
    const linkTarget = mkdtempSync(join(tmpdir(), 'dev-sync-root-real-'))
    owned.push(linkTarget)
    mkdirSync(join(repo, 'local'), { recursive: true })
    symlinkSync(linkTarget, join(repo, 'local', 'dev-sync'))
    expect(() => resolveDevSyncLayout(repo)).toThrow(/symlink/)
  })
})

describe('resolvePersistentSessionLayout', () => {
  it('resolves adopted session subpaths including the relay DB path', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const session = resolvePersistentSessionLayout(layout, 'sess-20261005-120000-123-abcdef')
    expect(session.dir).toBe(join(layout.sessionsDir, 'sess-20261005-120000-123-abcdef'))
    expect(session.profileA).toBe(join(session.dir, 'profile-a'))
    expect(session.profileB).toBe(join(session.dir, 'profile-b'))
    expect(session.relayDataDir).toBe(join(session.dir, 'relay-data'))
    expect(session.relayDb).toBe(join(session.dir, 'relay-data', 'relay.db'))
  })

  it('builds unique filesystem-safe ephemeral run ids', () => {
    const a = createSessionId(new Date('2026-10-05T12:00:00.000Z'), 111, 'aaaaaa')
    const b = createSessionId(new Date('2026-10-05T12:00:01.000Z'), 111, 'aaaaaa')
    expect(isValidSessionId(a)).toBe(true)
    expect(isValidSessionId(b)).toBe(true)
    expect(a).not.toBe(b)
    expect(isValidSessionId('../escape')).toBe(false)
    expect(isValidSessionId('')).toBe(false)
  })

  it('resolves the same adopted paths twice without requiring freshness', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    makeCompletePair(layout, 'sess-20261005-120000-123-abcdef')
    const first = resolvePersistentSessionLayout(layout, 'sess-20261005-120000-123-abcdef')
    const second = resolvePersistentSessionLayout(layout, 'sess-20261005-120000-123-abcdef')
    expect(second).toEqual(first)
    expect(isCompleteSessionPair(first)).toBe(true)
  })

  it('refuses invalid session ids and symlinked session dirs', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    expect(() => resolvePersistentSessionLayout(layout, '../escape')).toThrow(/invalid session id/)
    mkdirSync(layout.sessionsDir, { recursive: true })
    const target = mkdtempSync(join(tmpdir(), 'dev-sync-sess-real-'))
    owned.push(target)
    symlinkSync(target, join(layout.sessionsDir, 'sess-linked-1'))
    expect(() => resolvePersistentSessionLayout(layout, 'sess-linked-1')).toThrow(/symlink/)
  })

  it('never resolves a production user-data name', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    expect(() => resolvePersistentSessionLayout(layout, 'CherryChat')).toThrow(
      /production user-data name|invalid session id/
    )
  })
})

describe('isCompleteSessionPair', () => {
  it('is metadata-only: complete only with both profiles and the relay DB', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const session = resolvePersistentSessionLayout(layout, 'sess-complete-1')
    expect(isCompleteSessionPair(session)).toBe(false)
    mkdirSync(session.profileA, { recursive: true })
    mkdirSync(session.profileB, { recursive: true })
    mkdirSync(session.relayDataDir, { recursive: true })
    expect(isCompleteSessionPair(session)).toBe(false)
    writeFileSync(session.relayDb, 'synthetic-marker-bytes')
    expect(isCompleteSessionPair(session)).toBe(true)
  })

  it('fails closed on symlinked members', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    makeCompletePair(layout, 'sess-sym-1')
    const session = resolvePersistentSessionLayout(layout, 'sess-sym-1')
    const target = mkdtempSync(join(tmpdir(), 'dev-sync-prof-real-'))
    owned.push(target)
    rmSync(session.profileB, { recursive: true, force: true })
    symlinkSync(target, session.profileB)
    expect(isCompleteSessionPair(session)).toBe(false)
  })
})

describe('active pointer', () => {
  it('round-trips a basename-only pointer with strict kind/version', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    expect(readActivePointer(layout.activeFile)).toBeNull()
    writeActivePointerAtomic(layout.activeFile, 'sess-20261006-051530-373-9f4ecd')
    const pointer = readActivePointer(layout.activeFile)
    expect(pointer).toMatchObject({
      kind: DEV_SYNC_ACTIVE_KIND,
      version: DEV_SYNC_ACTIVE_VERSION,
      session: 'sess-20261006-051530-373-9f4ecd'
    })
    const mode = statSync(layout.activeFile).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })

  it('refuses absolute paths, unknown kind/version, and malformed JSON', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    expect(() => writeActivePointerAtomic(layout.activeFile, '/private/var/data')).toThrow(/basename/)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.activeFile, JSON.stringify({ kind: 'other', version: 1, session: 'sess-x', adoptedAt: 't' }))
    expect(() => readActivePointer(layout.activeFile)).toThrow(/unknown kind/)
    writeFileSync(
      layout.activeFile,
      JSON.stringify({ kind: DEV_SYNC_ACTIVE_KIND, version: 999, session: 'sess-x', adoptedAt: 't' })
    )
    expect(() => readActivePointer(layout.activeFile)).toThrow(/unknown version/)
    writeFileSync(layout.activeFile, 'not-json{{{')
    expect(() => readActivePointer(layout.activeFile)).toThrow(/malformed JSON/)
  })
})

describe('resolveActiveSessionLayout', () => {
  it('adopts the latest complete pair once, then reuses the pointer (same paths twice)', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    makeCompletePair(layout, 'sess-20261005-120000-111-aaaaaa')
    makeCompletePair(layout, 'sess-20261006-051530-373-9f4ecd')
    const first = resolveActiveSessionLayout(layout)
    expect(first.session.id).toBe('sess-20261006-051530-373-9f4ecd')
    expect(first.created).toBe(true)
    // Synthetic marker inside the adopted profile proves content is preserved.
    const markerFile = join(first.session.profileA, 'marker.bin')
    writeFileSync(markerFile, 'marker-bytes-v1')
    const second = resolveActiveSessionLayout(layout)
    expect(second.session).toEqual(first.session)
    expect(second.reused).toBe(true)
    expect(readFileSync(markerFile, 'utf8')).toBe('marker-bytes-v1')
    // No unexpected fresh session dir appeared on repeat.
    expect(listSessionBasenames(layout.sessionsDir)).toEqual([
      'sess-20261005-120000-111-aaaaaa',
      'sess-20261006-051530-373-9f4ecd'
    ])
  })

  it('always reuses a valid pointer even when newer complete metadata exists', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    makeCompletePair(layout, 'sess-20261005-120000-111-aaaaaa')
    writeActivePointerAtomic(layout.activeFile, 'sess-20261005-120000-111-aaaaaa')
    makeCompletePair(layout, 'sess-20261006-051530-373-9f4ecd')
    const resolved = resolveActiveSessionLayout(layout)
    expect(resolved.session.id).toBe('sess-20261005-120000-111-aaaaaa')
    expect(resolved.reused).toBe(true)
  })

  it('fails closed on a corrupted pointer instead of silently re-choosing', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    makeCompletePair(layout, 'sess-20261006-051530-373-9f4ecd')
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.activeFile, 'not-json{{{')
    expect(() => resolveActiveSessionLayout(layout)).toThrow(/malformed JSON/)
    expect(listSessionBasenames(layout.sessionsDir)).toEqual(['sess-20261006-051530-373-9f4ecd'])
  })

  it('fails closed when the adopted target is missing or partial', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    mkdirSync(layout.sessionsDir, { recursive: true })
    writeActivePointerAtomic(layout.activeFile, 'sess-missing-1')
    expect(() => resolveActiveSessionLayout(layout)).toThrow(/incomplete or missing/)

    const repo2 = makeRepoRoot()
    const layout2 = resolveDevSyncLayout(repo2)
    const partial = resolvePersistentSessionLayout(layout2, 'sess-partial-1')
    mkdirSync(partial.profileA, { recursive: true })
    writeActivePointerAtomic(layout2.activeFile, 'sess-partial-1')
    expect(() => resolveActiveSessionLayout(layout2)).toThrow(/incomplete or missing/)
  })

  it('fails closed when sessions exist but none is complete (never a silent fresh pair)', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const partial = resolvePersistentSessionLayout(layout, 'sess-partial-1')
    mkdirSync(partial.profileA, { recursive: true })
    expect(() => resolveActiveSessionLayout(layout)).toThrow(/none is a complete/)
    expect(readActivePointer(layout.activeFile)).toBeNull()
  })

  it('creates ONE stable pair on a clean fixture and reuses it (not fresh)', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const first = resolveActiveSessionLayout(layout)
    expect(first.session.id).toBe(DEV_SYNC_STABLE_SESSION_ID)
    expect(first.created).toBe(true)
    const second = resolveActiveSessionLayout(layout)
    expect(second.session).toEqual(first.session)
    expect(second.reused).toBe(true)
    expect(listSessionBasenames(layout.sessionsDir)).toEqual([DEV_SYNC_STABLE_SESSION_ID])
  })

  it('leaves root-legacy dirs untouched without reading them', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    mkdirSync(join(layout.root, 'profile-a'), { recursive: true })
    writeFileSync(join(layout.root, 'profile-a', 'opaque.dat'), 'legacy-opaque-bytes')
    mkdirSync(join(layout.root, 'relay-data'), { recursive: true })
    writeFileSync(join(layout.root, 'relay-data', 'opaque.dat'), 'legacy-relay-bytes')
    makeCompletePair(layout, 'sess-20261006-051530-373-9f4ecd')
    const adopted = resolveActiveSessionLayout(layout)
    expect(adopted.session.id).toBe('sess-20261006-051530-373-9f4ecd')
    expect(readFileSync(join(layout.root, 'profile-a', 'opaque.dat'), 'utf8')).toBe('legacy-opaque-bytes')
    expect(readFileSync(join(layout.root, 'relay-data', 'opaque.dat'), 'utf8')).toBe('legacy-relay-bytes')
  })
})

describe('ensureFixtureMarker', () => {
  it('creates the owned marker once and reuses it', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    expect(ensureFixtureMarker(layout.fixtureFile)).toEqual({ created: true, migrated: false })
    expect(ensureFixtureMarker(layout.fixtureFile)).toEqual({ created: false, migrated: false })
  })

  it('migrates the legacy v1 marker in place and preserves legacy dirs', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(
      layout.fixtureFile,
      JSON.stringify({ kind: DEV_SYNC_LEGACY_FIXTURE_KIND, version: DEV_SYNC_LEGACY_FIXTURE_VERSION })
    )
    // Legacy all-data dirs stay on disk; only the marker is rewritten.
    mkdirSync(join(layout.root, 'profile-a'), { recursive: true })
    writeFileSync(join(layout.root, 'profile-a', 'opaque.dat'), 'opaque')
    mkdirSync(join(layout.root, 'relay-data'), { recursive: true })
    expect(ensureFixtureMarker(layout.fixtureFile)).toEqual({ created: false, migrated: true })
    const migrated = JSON.parse(readFileSync(layout.fixtureFile, 'utf8'))
    expect(migrated).toMatchObject({ kind: DEV_SYNC_FIXTURE_KIND, version: DEV_SYNC_FIXTURE_VERSION })
    expect(readFileSync(join(layout.root, 'profile-a', 'opaque.dat'), 'utf8')).toBe('opaque')
    expect(ensureFixtureMarker(layout.fixtureFile)).toEqual({ created: false, migrated: false })
  })

  it('refuses an unknown marker instead of reinterpreting foreign state', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.fixtureFile, JSON.stringify({ kind: 'something-else', version: 9 }))
    expect(() => ensureFixtureMarker(layout.fixtureFile)).toThrow(/unknown marker/)
  })

  it('refuses an unreadable marker', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.fixtureFile, 'not-json{{{')
    expect(() => ensureFixtureMarker(layout.fixtureFile)).toThrow(/unreadable marker/)
  })
})

describe('acquireSupervisorLock', () => {
  it('fails fast on a live owner and never kills it', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const first = acquireSupervisorLock(layout.lockFile)
    // The current process is the live owner: a duplicate start must refuse.
    expect(() => acquireSupervisorLock(layout.lockFile)).toThrow(/another dev:sync supervisor owns/)
    first.release()
    expect(readSupervisorLock(layout.lockFile)).toBeNull()
  })

  it('reclaims a stale lock and releases only its own', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.lockFile, JSON.stringify({ pid: 2 ** 30, startedAt: 'stale' }))
    const claimed = acquireSupervisorLock(layout.lockFile, () => false)
    expect(readSupervisorLock(layout.lockFile)?.pid).toBe(process.pid)
    // A foreign lock file must not be removed by our release.
    writeFileSync(layout.lockFile, JSON.stringify({ pid: 2 ** 30 + 1, startedAt: 'foreign' }))
    claimed.release()
    expect(readSupervisorLock(layout.lockFile)?.pid).toBe(2 ** 30 + 1)
  })
})
