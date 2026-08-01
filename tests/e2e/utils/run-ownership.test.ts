import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupExactProfile,
  createOwnedTmpRoot,
  OWNED_TMPROOT_PREFIX,
  removeOwnedSeedArtifacts,
  removeOwnedTmpRoot,
  validateOwnedRoot,
  validateProfileLaunchToken
} from './run-ownership'

const tempDirs: string[] = []

function tempDir(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-e2e-ownership-test-'))
  tempDirs.push(result)
  return result
}

function cleanTerminate() {
  return vi.fn().mockResolvedValue({ killedPids: [], remainingPids: [], errors: [] })
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('practical owned-root lifecycle', () => {
  it('creates atomic canonical unique roots with the expected prefix', () => {
    const tmp = tempDir()
    const rootA = createOwnedTmpRoot(tmp)
    const rootB = createOwnedTmpRoot(tmp)
    expect(path.basename(rootA)).toMatch(new RegExp(`^${OWNED_TMPROOT_PREFIX}`))
    expect(path.basename(rootB)).toMatch(new RegExp(`^${OWNED_TMPROOT_PREFIX}`))
    // Canonical: already realpath-normalized.
    expect(rootA).toBe(fs.realpathSync(rootA))
    expect(rootB).toBe(fs.realpathSync(rootB))
    // Unique: two mkdtemp roots are distinct and both survive.
    expect(rootA).not.toBe(rootB)
    for (const root of [rootA, rootB]) {
      const stat = fs.lstatSync(root)
      expect(stat.isDirectory()).toBe(true)
      expect(stat.isSymbolicLink()).toBe(false)
    }
  })

  it.runIf(process.platform === 'darwin')('canonicalizes macOS lexical temp aliases', () => {
    const canonicalTmpDir = fs.realpathSync(os.tmpdir())
    const lexicalTmpDir = canonicalTmpDir.startsWith('/private/')
      ? canonicalTmpDir.slice('/private'.length)
      : canonicalTmpDir
    const root = createOwnedTmpRoot(lexicalTmpDir)
    expect(root).toBe(fs.realpathSync(root))
    expect(validateOwnedRoot(root, lexicalTmpDir)).toBe(root)
  })

  it('validates the exact root shape: prefix, direct child, real non-symlink directory', () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    expect(validateOwnedRoot(root, tmp)).toBe(root)

    // Wrong prefix is refused even for a real directory.
    const wrongPrefix = path.join(tmp, 'cherry-e2e-other-root')
    fs.mkdirSync(wrongPrefix)
    expect(() => validateOwnedRoot(wrongPrefix, tmp)).toThrow(/prefix/i)

    // Symlink root is refused (never deleted).
    const target = path.join(tmp, 'target')
    fs.mkdirSync(target)
    const link = path.join(tmp, `${OWNED_TMPROOT_PREFIX}link`)
    fs.symlinkSync(target, link, 'dir')
    expect(() => validateOwnedRoot(link, tmp)).toThrow(/not a real/i)

    // Not a direct child of the canonical temp dir is refused.
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested)
    expect(() => validateOwnedRoot(nested, tmp)).toThrow(/direct child/i)

    // Absent root is refused.
    const absent = path.join(tmp, `${OWNED_TMPROOT_PREFIX}absent`)
    expect(() => validateOwnedRoot(absent, tmp)).toThrow(/does not exist/i)
  })

  it('validates profile launch tokens inside the owned root', () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    const profile = path.join(root, 'profile')
    // createIfMissing creates the exact canonical token.
    expect(validateProfileLaunchToken(root, profile, true, tmp)).toBe(profile)
    expect(fs.statSync(profile).isDirectory()).toBe(true)

    // A path outside the root is refused.
    const outside = path.join(tmp, 'cherry-e2e-outside')
    expect(() => validateProfileLaunchToken(root, outside, false, tmp)).toThrow(/inside the owned root/i)
    // Relative tokens are refused.
    expect(() => validateProfileLaunchToken(root, 'relative-profile', false, tmp)).toThrow(/absolute/i)
    // Parent traversal is refused (raw token keeps the literal ".." segment).
    expect(() => validateProfileLaunchToken(root, `${root}/../escape`, false, tmp)).toThrow(/\.\./i)
    // A symlink profile is refused.
    const target = path.join(root, 'target')
    fs.mkdirSync(target)
    const link = path.join(root, 'profile-link')
    fs.symlinkSync(target, link, 'dir')
    expect(() => validateProfileLaunchToken(root, link, false, tmp)).toThrow(/real non-symlink/i)
  })

  it('removes the root after exact-cleaning every known profile', async () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    const profileA = path.join(root, 'profile-a')
    const profileB = path.join(root, 'profile-b')
    fs.mkdirSync(profileA)
    fs.mkdirSync(profileB)
    const terminate = cleanTerminate()
    const find = vi.fn().mockReturnValue([])
    await removeOwnedTmpRoot(root, [profileA, profileB], { terminate, find }, tmp)
    expect(terminate).toHaveBeenCalledWith(profileA)
    expect(terminate).toHaveBeenCalledWith(profileB)
    expect(fs.existsSync(root)).toBe(false)
  })

  it('preserves the root and reports its path when a profile cleanup fails', async () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile)
    const terminate = vi
      .fn()
      .mockResolvedValue({ killedPids: [9], remainingPids: [41], errors: ['SIGKILL 41: permission denied'] })
    const find = vi.fn().mockReturnValue([{ pid: 41, args: `--user-data-dir=${profile}` }])

    const error = await removeOwnedTmpRoot(root, [profile], { terminate, find }, tmp).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain(root)
    expect(fs.existsSync(root)).toBe(true)
  })

  it('preserves the root when final verification still finds an exact-token process', async () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    const profile = path.join(root, 'profile')
    fs.mkdirSync(profile)
    const terminate = cleanTerminate()
    const find = vi.fn().mockReturnValue([{ pid: 7, args: `--user-data-dir=${profile}` }])

    const error = await removeOwnedTmpRoot(root, [profile], { terminate, find }, tmp).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain(root)
    expect(fs.existsSync(root)).toBe(true)
  })

  it('preserves the root when root validation fails', async () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    // Corrupt the prefix by renaming the root to a non-owned name.
    const renamed = path.join(tmp, 'not-an-owned-root')
    fs.renameSync(root, renamed)
    const error = await removeOwnedTmpRoot(renamed, [], {}, tmp).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain(renamed)
    expect(fs.existsSync(renamed)).toBe(true)
  })

  it('two roots never delete each other', async () => {
    const tmp = tempDir()
    const rootA = createOwnedTmpRoot(tmp)
    const rootB = createOwnedTmpRoot(tmp)
    const profileA = path.join(rootA, 'profile-a')
    const profileB = path.join(rootB, 'profile-b')
    fs.mkdirSync(profileA)
    fs.mkdirSync(profileB)
    const deps = { terminate: cleanTerminate(), find: vi.fn().mockReturnValue([]) }

    await removeOwnedTmpRoot(rootA, [profileA], deps, tmp)
    expect(fs.existsSync(rootA)).toBe(false)
    expect(fs.existsSync(rootB)).toBe(true)
    expect(fs.existsSync(profileB)).toBe(true)

    await removeOwnedTmpRoot(rootB, [profileB], deps, tmp)
    expect(fs.existsSync(rootB)).toBe(false)
  })

  it('cleans an already-absent root as a no-op after exact profile cleanup', async () => {
    const tmp = tempDir()
    const root = createOwnedTmpRoot(tmp)
    const terminate = cleanTerminate()
    const find = vi.fn().mockReturnValue([])
    await removeOwnedTmpRoot(root, [], { terminate, find }, tmp)
    expect(fs.existsSync(root)).toBe(false)
    // Root already gone: removing again succeeds.
    await expect(removeOwnedTmpRoot(root, [], { terminate, find }, tmp)).resolves.toBeUndefined()
  })
})

describe('exact-profile cleanup', () => {
  it('succeeds on clean termination with empty final verification', async () => {
    await expect(
      cleanupExactProfile('/owned/profile', { terminate: cleanTerminate(), find: vi.fn().mockReturnValue([]) })
    ).resolves.toBeUndefined()
  })

  it('reports terminator errors and remaining PIDs', async () => {
    const error = await cleanupExactProfile('/owned/profile', {
      terminate: vi.fn().mockResolvedValue({ killedPids: [7], remainingPids: [8], errors: ['SIGKILL 8: denied'] }),
      find: vi.fn().mockReturnValue([])
    }).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain('/owned/profile')
    const messages = error.errors.map((entry: Error) => entry.message)
    expect(messages).toContain('SIGKILL 8: denied')
    expect(messages.some((m: string) => m.includes('processes remained'))).toBe(true)
  })

  it('reports final-verification remaining processes', async () => {
    const error = await cleanupExactProfile('/owned/profile', {
      terminate: cleanTerminate(),
      find: vi.fn().mockReturnValue([{ pid: 5, args: '--user-data-dir=/owned/profile' }])
    }).catch((e) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.map((entry: Error) => entry.message).join('; ')).toMatch(/processes remained/)
  })
})

describe('seed artifact cleanup', () => {
  it('removes only the exact seed dirs and ZIP, verifying absence', () => {
    const root = createOwnedTmpRoot(tempDir())
    const work = path.join(root, 'seed-work')
    const profile = path.join(root, 'seed-profile')
    fs.mkdirSync(work)
    fs.mkdirSync(profile)
    const zipPath = path.join(work, 'seed.zip')
    fs.writeFileSync(zipPath, 'zip')

    removeOwnedSeedArtifacts([work, profile], zipPath)
    // The owned root itself is untouched; every seed artifact is gone.
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('preserves seed artifacts and throws when a dir cannot be removed', () => {
    const root = createOwnedTmpRoot(tempDir())
    const work = path.join(root, 'seed-work')
    fs.mkdirSync(work)
    // A read-only parent blocks unlink of the seed dir on POSIX.
    fs.chmodSync(root, 0o500)
    try {
      expect(() => removeOwnedSeedArtifacts([work])).toThrow(/seed cleanup failed/i)
      expect(fs.existsSync(work)).toBe(true)
    } finally {
      fs.chmodSync(root, 0o700)
    }
  })
})

describe('seed cleanup contract (close exact cleanup before artifact removal)', () => {
  it('keeps seed artifacts when exact-profile cleanup fails', async () => {
    const root = createOwnedTmpRoot(tempDir())
    const profileDir = path.join(root, 'seed-profile')
    const workDir = path.join(root, 'seed-work')
    fs.mkdirSync(profileDir)
    fs.mkdirSync(workDir)
    const zipPath = path.join(workDir, 'seed.zip')
    fs.writeFileSync(zipPath, 'zip')

    // Exact-profile cleanup fails (remaining PID) — the seed contract must
    // NOT remove artifacts in this state.
    const terminate = vi.fn().mockResolvedValue({ killedPids: [], remainingPids: [1], errors: ['permission denied'] })
    const find = vi.fn().mockReturnValue([{ pid: 1, args: 'x' }])
    await expect(cleanupExactProfile(profileDir, { terminate, find })).rejects.toThrow()
    expect(fs.existsSync(profileDir)).toBe(true)
    expect(fs.existsSync(workDir)).toBe(true)
    expect(fs.existsSync(zipPath)).toBe(true)
  })

  it('removes artifacts only after exact-profile cleanup succeeds', async () => {
    const root = createOwnedTmpRoot(tempDir())
    const profileDir = path.join(root, 'seed-profile')
    const workDir = path.join(root, 'seed-work')
    fs.mkdirSync(profileDir)
    fs.mkdirSync(workDir)
    const zipPath = path.join(workDir, 'seed.zip')
    fs.writeFileSync(zipPath, 'zip')

    await cleanupExactProfile(profileDir, { terminate: cleanTerminate(), find: vi.fn().mockReturnValue([]) })
    removeOwnedSeedArtifacts([profileDir, workDir], zipPath)
    expect(fs.existsSync(profileDir)).toBe(false)
    expect(fs.existsSync(workDir)).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
  })
})
