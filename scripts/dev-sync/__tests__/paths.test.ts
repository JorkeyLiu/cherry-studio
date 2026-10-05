import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEV_SYNC_FIXTURE_KIND,
  DEV_SYNC_FIXTURE_VERSION,
  DEV_SYNC_LEGACY_FIXTURE_KIND,
  DEV_SYNC_LEGACY_FIXTURE_VERSION
} from '../constants'
import {
  acquireSupervisorLock,
  createSessionId,
  ensureFixtureMarker,
  isValidSessionId,
  readSupervisorLock,
  resolveDevSyncLayout,
  resolveSessionLayout
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

describe('resolveDevSyncLayout', () => {
  it('resolves the durable fixture paths under local/dev-sync (no persistent profiles)', () => {
    const layout = resolveDevSyncLayout(makeRepoRoot())
    expect(layout.root.endsWith(join('local', 'dev-sync'))).toBe(true)
    expect(layout.sessionsDir).toBe(join(layout.root, 'sessions'))
    expect(layout.settingsSeedA).toBe(join(layout.root, 'settings-a.json'))
    expect(layout.settingsSeedB).toBe(join(layout.root, 'settings-b.json'))
    expect(layout.lockFile).toBe(join(layout.root, '.dev-sync.lock'))
    // No persistent profile-a/profile-b at the root: sessions own profiles.
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

describe('resolveSessionLayout', () => {
  it('resolves fresh unique session subpaths under sessions/<id>', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const session = resolveSessionLayout(layout, 'sess-20261005-120000-123-abcdef')
    expect(session.dir).toBe(join(layout.sessionsDir, 'sess-20261005-120000-123-abcdef'))
    expect(session.profileA).toBe(join(session.dir, 'profile-a'))
    expect(session.profileB).toBe(join(session.dir, 'profile-b'))
    expect(session.relayDataDir).toBe(join(session.dir, 'relay-data'))
  })

  it('builds unique filesystem-safe session ids', () => {
    const a = createSessionId(new Date('2026-10-05T12:00:00.000Z'), 111, 'aaaaaa')
    const b = createSessionId(new Date('2026-10-05T12:00:01.000Z'), 111, 'aaaaaa')
    expect(isValidSessionId(a)).toBe(true)
    expect(isValidSessionId(b)).toBe(true)
    expect(a).not.toBe(b)
    expect(isValidSessionId('../escape')).toBe(false)
    expect(isValidSessionId('')).toBe(false)
  })

  it('refuses an existing session dir (never replay old content)', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    const session = resolveSessionLayout(layout, 'sess-fresh-1')
    mkdirSync(session.dir, { recursive: true })
    expect(() => resolveSessionLayout(layout, 'sess-fresh-1')).toThrow(/already exists/)
  })

  it('refuses invalid session ids and symlinked session dirs', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    expect(() => resolveSessionLayout(layout, '../escape')).toThrow(/invalid session id/)
    mkdirSync(layout.sessionsDir, { recursive: true })
    const target = mkdtempSync(join(tmpdir(), 'dev-sync-sess-real-'))
    owned.push(target)
    symlinkSync(target, join(layout.sessionsDir, 'sess-linked-1'))
    expect(() => resolveSessionLayout(layout, 'sess-linked-1')).toThrow(/symlink/)
  })

  it('never resolves a production user-data name', () => {
    const repo = makeRepoRoot()
    const layout = resolveDevSyncLayout(repo)
    // Session ids cannot express the forbidden basenames, but the guard
    // holds for any owned subpath shape via the session check.
    expect(() => resolveSessionLayout(layout, 'CherryChat')).toThrow(/production user-data name|invalid session id/)
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
