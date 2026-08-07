import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  actualCherryStudioProfilePath,
  canonicalPathsEqual,
  cherryStudioProfilePath,
  defaultCherryChatProfilePath,
  isForbiddenProfilePath,
  packagedLaunchArgs,
  profileFingerprintsEqual,
  resolvePackagedExecutablePath,
  snapshotProfileFingerprint
} from '../packaged-isolation'

// ---------------------------------------------------------------------------
// Focused unit tests for the packaged-isolation helper (Phase C). Pure
// functions only — no Electron, no Playwright. Real temp-dir fingerprints are
// created and removed inside the test (owned temp scope).
// ---------------------------------------------------------------------------

const tempRoots: string[] = []

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-isolation-test-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('resolvePackagedExecutablePath', () => {
  it('resolves the exact packaged mac-arm64 binary path', () => {
    expect(resolvePackagedExecutablePath('/repo/root')).toBe(
      path.join('/repo/root', 'dist', 'mac-arm64', 'Cherry Chat.app', 'Contents', 'MacOS', 'Cherry Chat')
    )
  })
})

describe('packagedLaunchArgs', () => {
  it('passes the exact `--user-data-dir=<token>` form with the proven flags', () => {
    expect(packagedLaunchArgs('/owned/profile')).toEqual([
      '--user-data-dir=/owned/profile',
      '--no-sandbox',
      '--disable-gpu'
    ])
  })
})

describe('canonicalPathsEqual', () => {
  it('treats identical paths as equal', () => {
    expect(canonicalPathsEqual('/a/b/c', '/a/b/c')).toBe(true)
  })

  it('treats paths differing only by parent symlink resolution as equal', () => {
    const root = makeTmpRoot()
    const realParent = path.join(root, 'real')
    fs.mkdirSync(realParent)
    const linkParent = path.join(root, 'link')
    fs.symlinkSync(realParent, linkParent)
    expect(canonicalPathsEqual(path.join(linkParent, 'profile'), path.join(realParent, 'profile'))).toBe(true)
  })

  it('rejects genuinely different paths', () => {
    const root = makeTmpRoot()
    const a = path.join(root, 'a')
    fs.mkdirSync(a)
    const b = path.join(root, 'b')
    fs.mkdirSync(b)
    expect(canonicalPathsEqual(a, b)).toBe(false)
  })
})

describe('isForbiddenProfilePath', () => {
  it('flags the ADR guard form, the actual Electron-derived form, and the default Cherry Chat profile', () => {
    const appDataRoot = '/mock/Application Support'
    expect(isForbiddenProfilePath(cherryStudioProfilePath(appDataRoot), appDataRoot)).toBe(true)
    expect(isForbiddenProfilePath(actualCherryStudioProfilePath(appDataRoot), appDataRoot)).toBe(true)
    expect(isForbiddenProfilePath(defaultCherryChatProfilePath(appDataRoot), appDataRoot)).toBe(true)
  })

  it('does not flag disposable or arbitrary paths', () => {
    const appDataRoot = '/mock/Application Support'
    expect(isForbiddenProfilePath('/var/folders/owned/cherry-chat-profile', appDataRoot)).toBe(false)
    expect(isForbiddenProfilePath('/mock/Application Support/Other App', appDataRoot)).toBe(false)
  })
})

describe('snapshotProfileFingerprint / profileFingerprintsEqual', () => {
  it('snapshots absence without touching anything', () => {
    const root = makeTmpRoot()
    const missing = path.join(root, 'missing')
    const fp = snapshotProfileFingerprint(missing)
    expect(fp).toEqual({ exists: false, stat: null, entries: null })
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('snapshots existence plus immediate-entry metadata (no recursion, no writes)', () => {
    const root = makeTmpRoot()
    const profile = path.join(root, 'Cherry Studio')
    fs.mkdirSync(profile)
    fs.writeFileSync(path.join(profile, 'a.txt'), 'content')
    fs.mkdirSync(path.join(profile, 'sub'))

    const fp = snapshotProfileFingerprint(profile)
    expect(fp.exists).toBe(true)
    expect(fp.stat).not.toBeNull()
    expect(fp.entries).not.toBeNull()
    // Entries sorted by name, immediate children only.
    expect(fp.entries!.map((e) => e.name)).toEqual(['a.txt', 'sub'])
    const fileEntry = fp.entries!.find((e) => e.name === 'a.txt')!
    expect(fileEntry.stat.type).toBe('file')
    expect(fileEntry.stat.size).toBe('content'.length)
    const dirEntry = fp.entries!.find((e) => e.name === 'sub')!
    expect(dirEntry.stat.type).toBe('directory')
  })

  it('detects creation of an immediate child (dir mtime + entry set)', () => {
    const root = makeTmpRoot()
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile)

    const before = snapshotProfileFingerprint(profile)
    // Give the directory a distinct mtime for a bounded second sample.
    fs.writeFileSync(path.join(profile, 'new-entry'), 'x')
    const after = snapshotProfileFingerprint(profile)

    expect(profileFingerprintsEqual(before, after)).toBe(false)
  })

  it('detects modification of an immediate child', () => {
    const root = makeTmpRoot()
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile)
    const file = path.join(profile, 'f.txt')
    fs.writeFileSync(file, 'one')

    const before = snapshotProfileFingerprint(profile)
    fs.writeFileSync(file, 'two-longer-content')
    const after = snapshotProfileFingerprint(profile)

    expect(profileFingerprintsEqual(before, after)).toBe(false)
  })

  it('reports two identical snapshots as unchanged', () => {
    const root = makeTmpRoot()
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile)
    fs.writeFileSync(path.join(profile, 'f.txt'), 'content')

    const first = snapshotProfileFingerprint(profile)
    const second = snapshotProfileFingerprint(profile)
    expect(profileFingerprintsEqual(first, second)).toBe(true)
  })

  it('reports absent vs present as different', () => {
    const root = makeTmpRoot()
    const profile = path.join(root, 'profile')
    expect(profileFingerprintsEqual(snapshotProfileFingerprint(profile), snapshotProfileFingerprint(profile))).toBe(
      true
    )
    fs.mkdirSync(profile)
    expect(profileFingerprintsEqual(snapshotProfileFingerprint(profile), snapshotProfileFingerprint(profile))).toBe(
      true
    )
    expect(
      profileFingerprintsEqual(
        snapshotProfileFingerprint(path.join(root, 'absent')),
        snapshotProfileFingerprint(profile)
      )
    ).toBe(false)
  })
})
