/**
 * Candidate database lifecycle tests (Phase 4.2).
 *
 * Production-path style: unmock node:fs/os/path/crypto and use the REAL
 * ChatDbService + native better-sqlite3 so the candidate module is exercised
 * exactly as it runs in Main. A temp Data root is injected per test so no
 * live Data path is ever touched (LOCK-4202B).
 *
 * Coverage:
 * - Initialized candidate uses a non-live, owned path (isolation).
 * - Path traversal / unsafe session IDs are rejected at construction.
 * - Idempotency of initialize(), seal(), and discard().
 * - Live DB isolation sentinel: live Data/chat.db is never touched.
 * - Bounded EBUSY retry behavior on deletion.
 * - Sealed candidate persists on disk for Phase 4.3.
 * - discard() removes chat.db and its WAL/SHM sidecars.
 * - Orphan recovery removes only owned, aged directories and nothing else.
 */

import * as fs from 'node:fs'
// Default (mutable) fs object — spy target for bounded fault injection; the
// candidate module imports the same default object (house pattern).
import nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type BetterSqlite3 from 'better-sqlite3'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Unmock the globally-mocked node modules — we need real filesystem behavior.
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

// Mock @main/config so importing chatDb does not trigger getDataPath().
// Every CandidateDbResource in these tests injects an explicit dataRoot.
vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

import {
  CANDIDATE_DIR_PREFIX,
  CANDIDATE_ROOT_DIRNAME,
  CandidateDbResource,
  getCandidateRoot,
  getOwnedCandidateDirName,
  isValidCandidateId,
  isValidOwnedCandidateId,
  recoverOrphanedCandidates,
  removeConvergedCandidate,
  resealSealedCandidate
} from '../candidateDb'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDataRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-candidate-test-'))
}

function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

const VALID_SESSION_ID = '11111111-2222-3333-4444-555555555555'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('candidateDb — lifecycle primitives', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeDataRoot()
  })

  afterEach(() => {
    rmrf(dataRoot)
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Path ownership + isolation
  // -------------------------------------------------------------------------

  describe('ownership & isolation', () => {
    it('places the candidate under the owned root with the owned prefix', () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })

      const expectedRoot = path.join(dataRoot, CANDIDATE_ROOT_DIRNAME)
      expect(getCandidateRoot(dataRoot)).toBe(expectedRoot)
      expect(res.getCandidateDir()).toBe(path.join(expectedRoot, `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      expect(res.getDbPath()).toBe(path.join(res.getCandidateDir(), 'chat.db'))
    })

    it('initialized candidate uses a non-live path', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()

      const liveDbPath = path.join(dataRoot, 'chat.db')
      expect(res.getDbPath()).not.toBe(liveDbPath)
      expect(res.getDbPath().startsWith(getCandidateRoot(dataRoot) + path.sep)).toBe(true)
      expect(fs.existsSync(res.getDbPath())).toBe(true)
      expect(res.getState()).toBe('initialized')

      res.seal()
    })

    it('does not open or mutate the live Data/chat.db (isolation sentinel)', async () => {
      // Simulate a pre-existing live DB with a sentinel value.
      const liveDbPath = path.join(dataRoot, 'chat.db')
      fs.writeFileSync(liveDbPath, 'LIVE-SENTINEL', 'utf-8')
      const before = fs.readFileSync(liveDbPath, 'utf-8')

      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      // Perform a write against the candidate DB.
      const sqlite = res.getSqlite() as BetterSqlite3.Database
      sqlite.prepare("INSERT INTO topics (id, name) VALUES ('t1', 'x')").run()

      await res.discard()

      // Live DB untouched byte-for-byte.
      expect(fs.readFileSync(liveDbPath, 'utf-8')).toBe(before)
    })
  })

  // -------------------------------------------------------------------------
  // Path traversal rejection
  // -------------------------------------------------------------------------

  describe('session ID / path safety', () => {
    it.each(['../escape', '..', 'a/b', 'a\\b', 'foo.bar', '', 'with space', 'a'.repeat(200)])(
      'rejects unsafe session ID %j',
      (badId) => {
        expect(() => new CandidateDbResource({ sessionId: badId, dataRoot })).toThrow()
      }
    )

    it('accepts UUID-style session IDs', () => {
      expect(() => new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })).not.toThrow()
      expect(() => new CandidateDbResource({ sessionId: 'abc_DEF-123', dataRoot })).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('initialize() is idempotent while initialized', async () => {
      const factory = vi.fn((dbDir: string) => makeFakeService(dbDir))
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      await res.initialize()
      await res.initialize()

      expect(factory).toHaveBeenCalledTimes(1)
      expect(res.getState()).toBe('initialized')
    })

    it('seal() is idempotent and closes the handle once effective', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      const res = new CandidateDbResource({
        sessionId: VALID_SESSION_ID,
        dataRoot,
        chatDbServiceFactory: () => fake
      })

      await res.initialize()
      res.seal()
      res.seal()
      res.seal()

      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(res.getState()).toBe('sealed')
    })

    it('discard() is idempotent (no throw on already-removed dir)', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()

      await res.discard()
      expect(fs.existsSync(res.getCandidateDir())).toBe(false)
      await expect(res.discard()).resolves.not.toThrow()
      expect(res.getState()).toBe('discarded')
    })

    it('refuses initialize() after seal or discard', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      res.seal()
      await expect(res.initialize()).rejects.toThrow(/sealed/)
    })

    it('getService/getSqlite throw before initialize', () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      expect(() => res.getService()).toThrow(/not initialized/)
      expect(() => res.getSqlite()).toThrow(/not initialized/)
    })
  })

  // -------------------------------------------------------------------------
  // Seal persistence & discard cleanup
  // -------------------------------------------------------------------------

  describe('seal persistence & discard cleanup', () => {
    it('sealed candidate persists on disk for Phase 4.3', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()

      const dbPath = res.getDbPath()
      expect(fs.existsSync(dbPath)).toBe(true)

      res.seal()

      // Files remain — no rename/promote/deletion on seal.
      expect(fs.existsSync(dbPath)).toBe(true)
      expect(fs.existsSync(res.getCandidateDir())).toBe(true)
      expect(res.getState()).toBe('sealed')
    })

    it('discard removes chat.db and its WAL/SHM sidecars', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()

      // Force WAL/SHM sidecar creation with a write.
      const sqlite = res.getSqlite() as BetterSqlite3.Database
      sqlite.prepare("INSERT INTO topics (id, name) VALUES ('t1', 'x')").run()

      const dir = res.getCandidateDir()
      const dbPath = res.getDbPath()
      // Sanity: sidecars exist (or at least chat.db does).
      expect(fs.existsSync(dbPath)).toBe(true)

      await res.discard()

      expect(fs.existsSync(dir)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(false)
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Bounded EBUSY retry
  // -------------------------------------------------------------------------

  describe('bounded EBUSY retry on deletion', () => {
    it('retries up to MAX_RETRY_ATTEMPTS then throws on persistent EBUSY', async () => {
      const res = new CandidateDbResource({
        sessionId: VALID_SESSION_ID,
        dataRoot,
        chatDbServiceFactory: (dbDir) => makeFakeService(dbDir)
      })
      await res.initialize()

      const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      const rmSpy = vi.spyOn(fs.promises, 'rm').mockRejectedValue(busy)

      vi.useFakeTimers()
      const p = res.discard()
      // Attach a catch immediately so the rejection is observed.
      const assertion = expect(p).rejects.toBe(busy)
      await vi.runAllTimersAsync()
      await assertion
      vi.useRealTimers()

      expect(rmSpy).toHaveBeenCalledTimes(3)
    })

    it('succeeds when EBUSY clears within the retry budget', async () => {
      const res = new CandidateDbResource({
        sessionId: VALID_SESSION_ID,
        dataRoot,
        chatDbServiceFactory: (dbDir) => makeFakeService(dbDir)
      })
      await res.initialize()

      const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      const rmSpy = vi
        .spyOn(fs.promises, 'rm')
        .mockRejectedValueOnce(busy)
        .mockResolvedValueOnce(undefined as unknown as void)

      vi.useFakeTimers()
      const p = res.discard()
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBeUndefined()
      vi.useRealTimers()

      expect(rmSpy).toHaveBeenCalledTimes(2)
      expect(res.getState()).toBe('discarded')
    })
  })

  // -------------------------------------------------------------------------
  // Orphan recovery filtering
  // -------------------------------------------------------------------------

  describe('recoverOrphanedCandidates', () => {
    const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000)

    function makeDir(name: string, aged: boolean): string {
      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(root, { recursive: true })
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      if (aged) fs.utimesSync(dir, TWO_HOURS_AGO, TWO_HOURS_AGO)
      return dir
    }

    it('removes owned candidate directories older than the age policy', async () => {
      const old = makeDir(`${CANDIDATE_DIR_PREFIX}old-session`, true)
      await recoverOrphanedCandidates(dataRoot)
      expect(fs.existsSync(old)).toBe(false)
    })

    it('preserves owned candidates younger than the age policy', async () => {
      const young = makeDir(`${CANDIDATE_DIR_PREFIX}young-session`, false)
      await recoverOrphanedCandidates(dataRoot)
      expect(fs.existsSync(young)).toBe(true)
    })

    it('never removes directories not matching the owned prefix, even when aged', async () => {
      const unrelated = makeDir('unrelated-dir', true)
      const alsoUnrelated = makeDir('cherry-import-abc', true) // tempWorkspace prefix, not ours
      await recoverOrphanedCandidates(dataRoot)
      expect(fs.existsSync(unrelated)).toBe(true)
      expect(fs.existsSync(alsoUnrelated)).toBe(true)
    })

    it('never removes a symlinked candidate leaf — the link and its target stay untouched (LOCK-LIFE-1)', async () => {
      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(root, { recursive: true })
      const target = path.join(dataRoot, 'symlink-target')
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'keep.txt'), 'x', 'utf-8')
      const link = path.join(root, `${CANDIDATE_DIR_PREFIX}symlink-session`)
      fs.symlinkSync(target, link, 'dir')

      await recoverOrphanedCandidates(dataRoot)

      // The symlink is NOT treated as an owned directory: neither the link
      // nor its target is removed.
      expect(fs.existsSync(link)).toBe(true)
      expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
    })

    it('is a no-op when the candidate root does not exist', async () => {
      // Fresh dataRoot with no candidate root yet.
      await expect(recoverOrphanedCandidates(dataRoot)).resolves.not.toThrow()
    })

    it('fails closed when the candidate ROOT itself is a symlink — no external cleanup (LOCK-LIFE-1)', async () => {
      // The root points at an external target that holds aged, owned-looking
      // candidates. readdir through the link would clean them up — the root
      // validation must fail closed before any readdir/removal.
      const external = path.join(dataRoot, 'recovery-external')
      fs.mkdirSync(external, { recursive: true })
      const aged = path.join(external, `${CANDIDATE_DIR_PREFIX}aged-session`)
      fs.mkdirSync(aged, { recursive: true })
      fs.utimesSync(aged, TWO_HOURS_AGO, TWO_HOURS_AGO)

      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(path.dirname(root), { recursive: true })
      fs.symlinkSync(external, root, 'dir')

      await expect(recoverOrphanedCandidates(dataRoot)).rejects.toThrow(/isolation refused|symlink/)

      // Fail closed: nothing under the external target was removed.
      expect(fs.existsSync(aged)).toBe(true)
    })

    it('fails closed when the candidate root is a regular file — no cleanup runs (LOCK-LIFE-1)', async () => {
      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(path.dirname(root), { recursive: true })
      fs.writeFileSync(root, 'not a directory', 'utf-8')

      await expect(recoverOrphanedCandidates(dataRoot)).rejects.toThrow(/isolation refused/)
    })

    // -----------------------------------------------------------------------
    // Journal-aware protection (Phase 4.4.1, LOCK-4413/4414/4415)
    // -----------------------------------------------------------------------

    describe('protected candidate IDs', () => {
      it('preserves an aged candidate named by a protected ID while cleaning other aged candidates (LOCK-4413)', async () => {
        // The protected ID is the opaque candidate directory ID exactly as
        // the import session emits it and the journal records it — i.e. the
        // full owned leaf name, mapped exactly once (no re-prefixing).
        const protectedDir = makeDir(`${CANDIDATE_DIR_PREFIX}promoting-session`, true)
        const unprotectedDir = makeDir(`${CANDIDATE_DIR_PREFIX}stale-session`, true)

        await recoverOrphanedCandidates(dataRoot, {
          protectedCandidateIds: [`${CANDIDATE_DIR_PREFIX}promoting-session`]
        })

        // Journal-named candidate survives despite exceeding the age policy.
        expect(fs.existsSync(protectedDir)).toBe(true)
        // Ordinary aged orphan is still cleaned.
        expect(fs.existsSync(unprotectedDir)).toBe(false)
      })

      it('a real journal candidateId protects the real aged candidate directory (accepted 4.4.1 audit blocker)', async () => {
        // End-to-end realistic shapes: CandidateDbResource creates the
        // on-disk leaf for an import session ID, and the import session /
        // promotion journal emit candidateId = `candidate-<sessionId>`.
        const sessionId = 'import-m3k9zq1-a1b2c3d4'
        const journalCandidateId = `${CANDIDATE_DIR_PREFIX}${sessionId}` // InternalImportSession.candidateId shape

        const resource = new CandidateDbResource({
          sessionId,
          dataRoot,
          chatDbServiceFactory: makeFakeService
        })
        await resource.initialize()
        resource.seal()
        // The on-disk leaf equals the journal candidateId byte-for-byte.
        expect(path.basename(resource.getCandidateDir())).toBe(journalCandidateId)

        // Age the real candidate past the orphan policy.
        const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000)
        fs.utimesSync(resource.getCandidateDir(), TWO_HOURS_AGO, TWO_HOURS_AGO)
        const staleDir = makeDir(`${CANDIDATE_DIR_PREFIX}import-other-session`, true)

        await recoverOrphanedCandidates(dataRoot, { protectedCandidateIds: [journalCandidateId] })

        // The journal-referenced promoting candidate survives (LOCK-4413/4415)…
        expect(fs.existsSync(resource.getCandidateDir())).toBe(true)
        expect(fs.existsSync(resource.getDbPath())).toBe(true)
        // …while an ordinary aged orphan is still cleaned.
        expect(fs.existsSync(staleDir)).toBe(false)
      })

      it('protection does not change young / non-owned candidate behavior', async () => {
        const young = makeDir(`${CANDIDATE_DIR_PREFIX}young-session`, false)
        const unrelated = makeDir('unrelated-dir', true)

        await recoverOrphanedCandidates(dataRoot, {
          protectedCandidateIds: [`${CANDIDATE_DIR_PREFIX}promoting-session`]
        })

        expect(fs.existsSync(young)).toBe(true)
        expect(fs.existsSync(unrelated)).toBe(true)
      })

      it.each(['../escape', '..', 'a/b', 'a\\b', 'foo.bar', '', 'candidate-x/../../etc'])(
        'rejects unsafe protected ID %j before deleting anything (LOCK-4415)',
        async (badId) => {
          const aged = makeDir(`${CANDIDATE_DIR_PREFIX}stale-session`, true)

          await expect(recoverOrphanedCandidates(dataRoot, { protectedCandidateIds: [badId] })).rejects.toThrow(
            /path safety/
          )

          // Validation happens BEFORE any filesystem access: nothing deleted.
          expect(fs.existsSync(aged)).toBe(true)
        }
      )

      it.each(['promoting-session', 'candidate-', 'candidatex'])(
        'rejects a protected ID without the exact owned prefix %j (cannot map to an owned leaf)',
        async (badId) => {
          const aged = makeDir(`${CANDIDATE_DIR_PREFIX}stale-session`, true)

          await expect(recoverOrphanedCandidates(dataRoot, { protectedCandidateIds: [badId] })).rejects.toThrow(
            /path safety/
          )
          expect(fs.existsSync(aged)).toBe(true)
        }
      )

      it('an absolute path cannot protect anything and aborts cleanup (no path input accepted)', async () => {
        const aged = makeDir(`${CANDIDATE_DIR_PREFIX}stale-session`, true)
        const absolute = path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}stale-session`)

        await expect(recoverOrphanedCandidates(dataRoot, { protectedCandidateIds: [absolute] })).rejects.toThrow(
          /path safety/
        )
        expect(fs.existsSync(aged)).toBe(true)
      })

      it('empty protection list behaves exactly like the unprotected call (absent journal path)', async () => {
        const old = makeDir(`${CANDIDATE_DIR_PREFIX}old-session`, true)

        await recoverOrphanedCandidates(dataRoot, { protectedCandidateIds: [] })

        expect(fs.existsSync(old)).toBe(false)
      })
    })
  })

  // -------------------------------------------------------------------------
  // ID validation + owned leaf mapping (LOCK-4415)
  // -------------------------------------------------------------------------

  describe('candidate ID validation & owned leaf mapping', () => {
    it('isValidCandidateId matches the strict allowlist', () => {
      expect(isValidCandidateId(VALID_SESSION_ID)).toBe(true)
      expect(isValidCandidateId('abc_DEF-123')).toBe(true)
      expect(isValidCandidateId('../escape')).toBe(false)
      expect(isValidCandidateId('a/b')).toBe(false)
      expect(isValidCandidateId('foo.bar')).toBe(false)
      expect(isValidCandidateId('')).toBe(false)
      expect(isValidCandidateId('a'.repeat(200))).toBe(false)
      expect(isValidCandidateId(42)).toBe(false)
      expect(isValidCandidateId(null)).toBe(false)
    })

    it('isValidOwnedCandidateId requires the strict allowlist AND the owned prefix', () => {
      expect(isValidOwnedCandidateId(`${CANDIDATE_DIR_PREFIX}import-abc123`)).toBe(true)
      expect(isValidOwnedCandidateId(`${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`)).toBe(true)
      // No prefix / empty remainder cannot map to an owned leaf.
      expect(isValidOwnedCandidateId('import-abc123')).toBe(false)
      expect(isValidOwnedCandidateId(CANDIDATE_DIR_PREFIX)).toBe(false)
      expect(isValidOwnedCandidateId('candidate-x/../../etc')).toBe(false)
      expect(isValidOwnedCandidateId('../escape')).toBe(false)
      expect(isValidOwnedCandidateId('')).toBe(false)
      expect(isValidOwnedCandidateId(42)).toBe(false)
      expect(isValidOwnedCandidateId(null)).toBe(false)
    })

    it('getOwnedCandidateDirName maps a validated opaque candidate ID to the owned leaf exactly once', () => {
      // The candidate ID IS the leaf name — identity after validation,
      // never a second prefixing (accepted 4.4.1 audit blocker).
      expect(getOwnedCandidateDirName(`${CANDIDATE_DIR_PREFIX}abc-123`)).toBe(`${CANDIDATE_DIR_PREFIX}abc-123`)
      expect(getOwnedCandidateDirName(`${CANDIDATE_DIR_PREFIX}abc-123`)).not.toContain(path.sep)
      expect(getOwnedCandidateDirName(`${CANDIDATE_DIR_PREFIX}abc-123`)).not.toBe(
        `${CANDIDATE_DIR_PREFIX}${CANDIDATE_DIR_PREFIX}abc-123`
      )
    })

    it('getOwnedCandidateDirName throws for IDs that could smuggle a path or cannot map to an owned leaf', () => {
      expect(() => getOwnedCandidateDirName('../escape')).toThrow(/path safety/)
      expect(() => getOwnedCandidateDirName('a/b')).toThrow(/path safety/)
      expect(() => getOwnedCandidateDirName('')).toThrow(/path safety/)
      // Prefix-less IDs are refused: an ID that is not the owned leaf name
      // would silently protect nothing (LOCK-4415).
      expect(() => getOwnedCandidateDirName('abc-123')).toThrow(/path safety/)
      expect(() => getOwnedCandidateDirName(CANDIDATE_DIR_PREFIX)).toThrow(/path safety/)
    })
  })

  // -------------------------------------------------------------------------
  // removeConvergedCandidate — exact owned candidate removal after a
  // CONVERGED promotion (LOCK-CLEAN-1..5). Deletes ONLY the exact owned leaf
  // named by a validated candidate ID; the candidate root, unrelated
  // sessions, and foreign residue are never touched.
  // -------------------------------------------------------------------------

  describe('removeConvergedCandidate', () => {
    /** Create a candidate leaf that mirrors the post-promotion residue:
     *  only `files-catalog.json` remains (chat.db and Files/ were renamed
     *  away), plus an empty shell. */
    function makePromotedResidueLeaf(candidateId: string): string {
      const dir = path.join(getCandidateRoot(dataRoot), candidateId)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'files-catalog.json'), '{"version":1}', 'utf-8')
      return dir
    }

    it('removes the exact owned candidate shell including the files-catalog.json handoff', async () => {
      const candidateId = `${CANDIDATE_DIR_PREFIX}import-s1`
      const dir = makePromotedResidueLeaf(candidateId)
      expect(fs.existsSync(path.join(dir, 'files-catalog.json'))).toBe(true)

      const removed = await removeConvergedCandidate(candidateId, dataRoot)

      expect(removed).toBe(true)
      expect(fs.existsSync(dir)).toBe(false)
      expect(fs.existsSync(path.join(getCandidateRoot(dataRoot), candidateId))).toBe(false)
    })

    it('removes the entire owned leaf — chat.db, Files/, files-catalog.json, and the empty shell (LOCK-CLEAN-3)', async () => {
      const candidateId = `${CANDIDATE_DIR_PREFIX}import-s1`
      const dir = path.join(getCandidateRoot(dataRoot), candidateId)
      fs.mkdirSync(path.join(dir, 'Files'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'chat.db'), 'candidate-bytes', 'utf-8')
      fs.writeFileSync(path.join(dir, 'files-catalog.json'), '{"version":1}', 'utf-8')

      await removeConvergedCandidate(candidateId, dataRoot)

      expect(fs.existsSync(dir)).toBe(false)
    })

    it('is idempotent — a second call on an already-removed leaf returns true (LOCK-CLEAN-2)', async () => {
      const candidateId = `${CANDIDATE_DIR_PREFIX}import-s1`
      makePromotedResidueLeaf(candidateId)

      await expect(removeConvergedCandidate(candidateId, dataRoot)).resolves.toBe(true)
      await expect(removeConvergedCandidate(candidateId, dataRoot)).resolves.toBe(true)
      await expect(removeConvergedCandidate(candidateId, dataRoot)).resolves.toBe(true)
    })

    it('is a clean no-op when the candidate root itself does not exist yet', async () => {
      await expect(removeConvergedCandidate(`${CANDIDATE_DIR_PREFIX}import-s1`, dataRoot)).resolves.toBe(true)
    })

    it('preserves unrelated candidate sessions when removing exactly one (LOCK-CLEAN-2)', async () => {
      const keepId = `${CANDIDATE_DIR_PREFIX}import-keep`
      const keepDir = makePromotedResidueLeaf(keepId)
      const otherId = `${CANDIDATE_DIR_PREFIX}import-other`
      const otherDir = makePromotedResidueLeaf(otherId)
      const removeId = `${CANDIDATE_DIR_PREFIX}import-remove`
      const removeDir = makePromotedResidueLeaf(removeId)

      await removeConvergedCandidate(removeId, dataRoot)

      expect(fs.existsSync(removeDir)).toBe(false)
      expect(fs.existsSync(keepDir)).toBe(true)
      expect(fs.existsSync(path.join(keepDir, 'files-catalog.json'))).toBe(true)
      expect(fs.existsSync(otherDir)).toBe(true)
      // The candidate ROOT itself survives.
      expect(fs.existsSync(getCandidateRoot(dataRoot))).toBe(true)
    })

    it('never removes the candidate root or unrelated non-owned entries', async () => {
      const unrelated = path.join(dataRoot, 'unrelated-dir')
      fs.mkdirSync(unrelated, { recursive: true })
      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(root, { recursive: true })
      const unownedLeaf = path.join(root, 'unowned-leaf')
      fs.mkdirSync(unownedLeaf, { recursive: true })
      const candidateId = `${CANDIDATE_DIR_PREFIX}import-s1`
      makePromotedResidueLeaf(candidateId)

      await removeConvergedCandidate(candidateId, dataRoot)

      expect(fs.existsSync(root)).toBe(true)
      expect(fs.existsSync(unrelated)).toBe(true)
      expect(fs.existsSync(unownedLeaf)).toBe(true)
    })

    it.each([
      '../escape',
      '..',
      'a/b',
      'a\\b',
      'foo.bar',
      '',
      'a'.repeat(200),
      'candidate-x/../../etc',
      'candidate-..',
      CANDIDATE_DIR_PREFIX,
      'candidatex'
    ])('rejects malicious/foreign candidateId %j before deleting anything (LOCK-CLEAN-2)', async (badId) => {
      const keepId = `${CANDIDATE_DIR_PREFIX}import-keep`
      const keepDir = makePromotedResidueLeaf(keepId)

      await expect(removeConvergedCandidate(badId, dataRoot)).rejects.toThrow(/path safety/)

      // Fail closed: nothing was removed.
      expect(fs.existsSync(keepDir)).toBe(true)
      expect(fs.existsSync(path.join(keepDir, 'files-catalog.json'))).toBe(true)
    })

    it('a foreign-but-valid candidateId (no such owned leaf) is an idempotent clean state', async () => {
      const keepId = `${CANDIDATE_DIR_PREFIX}import-keep`
      const keepDir = makePromotedResidueLeaf(keepId)

      await expect(removeConvergedCandidate(`${CANDIDATE_DIR_PREFIX}import-unknown`, dataRoot)).resolves.toBe(true)

      // The unrelated session was never touched.
      expect(fs.existsSync(keepDir)).toBe(true)
    })

    it('leaves a non-directory (or symlink) at the owned leaf alone — never broad-deletes foreign residue', async () => {
      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(root, { recursive: true })
      const leafPath = path.join(root, `${CANDIDATE_DIR_PREFIX}import-s1`)
      // A regular FILE at the owned leaf — not an owned candidate directory.
      fs.writeFileSync(leafPath, 'foreign', 'utf-8')
      // A symlinked owned-looking leaf with a real target.
      const target = path.join(dataRoot, 'symlink-target')
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(path.join(target, 'keep.txt'), 'x', 'utf-8')
      const link = path.join(root, `${CANDIDATE_DIR_PREFIX}import-link`)
      fs.symlinkSync(target, link, 'dir')

      await expect(removeConvergedCandidate(`${CANDIDATE_DIR_PREFIX}import-s1`, dataRoot)).resolves.toBe(true)
      await expect(removeConvergedCandidate(`${CANDIDATE_DIR_PREFIX}import-link`, dataRoot)).resolves.toBe(true)

      // Neither the foreign file, the symlink, nor its target was removed.
      expect(fs.readFileSync(leafPath, 'utf-8')).toBe('foreign')
      expect(fs.existsSync(link)).toBe(true)
      expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true)
    })

    it('fails closed when the candidate ROOT is a symlink — no removal through an unvalidated root (LOCK-LIFE-1)', async () => {
      const external = path.join(dataRoot, 'recovery-external')
      fs.mkdirSync(external, { recursive: true })
      const aged = path.join(external, `${CANDIDATE_DIR_PREFIX}aged-session`)
      fs.mkdirSync(aged, { recursive: true })
      fs.writeFileSync(path.join(aged, 'files-catalog.json'), '{}', 'utf-8')

      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(path.dirname(root), { recursive: true })
      fs.symlinkSync(external, root, 'dir')

      await expect(removeConvergedCandidate(`${CANDIDATE_DIR_PREFIX}aged-session`, dataRoot)).rejects.toThrow(
        /isolation refused|symlink/
      )

      // Fail closed: nothing under the external target was removed.
      expect(fs.existsSync(aged)).toBe(true)
    })

    it('a persistent removal failure throws a fixed-context error (no private path) and leaves the leaf intact', async () => {
      const candidateId = `${CANDIDATE_DIR_PREFIX}import-s1`
      const dir = makePromotedResidueLeaf(candidateId)
      const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      // Mock the owned-leaf probe too so the fake-timer chain contains no
      // native I/O (the helper awaits lstat before the retried rm).
      const lstatSpy = vi.spyOn(fs.promises, 'lstat').mockResolvedValue({
        isDirectory: () => true
      } as unknown as fs.Stats)
      const rmSpy = vi.spyOn(fs.promises, 'rm').mockRejectedValue(busy)

      vi.useFakeTimers()
      const p = removeConvergedCandidate(candidateId, dataRoot)
      const assertion = expect(p).rejects.toThrow(/could not be removed/)
      await vi.runAllTimersAsync()
      await assertion
      vi.useRealTimers()

      expect(rmSpy).toHaveBeenCalledTimes(3)
      expect(lstatSpy).toHaveBeenCalledTimes(1)
      // The leaf remains on disk for age-based orphan cleanup (LOCK-CLEAN-4).
      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.existsSync(path.join(dir, 'files-catalog.json'))).toBe(true)
    })

    it('succeeds when EBUSY clears within the bounded retry budget', async () => {
      const candidateId = `${CANDIDATE_DIR_PREFIX}import-s1`
      const dir = makePromotedResidueLeaf(candidateId)
      const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      // Mock the owned-leaf probe so the fake-timer chain contains no native
      // I/O (the helper awaits lstat before the retried rm).
      vi.spyOn(fs.promises, 'lstat').mockResolvedValue({
        isDirectory: () => true
      } as unknown as fs.Stats)
      const origRm = fs.promises.rm.bind(fs.promises)
      const rmSpy = vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(busy).mockImplementationOnce(origRm)

      vi.useFakeTimers()
      const p = removeConvergedCandidate(candidateId, dataRoot)
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBe(true)
      vi.useRealTimers()

      expect(rmSpy).toHaveBeenCalledTimes(2)
      // The retried (real) removal actually deleted the owned leaf.
      expect(fs.existsSync(dir)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // LOCK-LIFE-1: candidate root/leaf reject symlinks and resolve inside the
  // owned candidates root — never onto the live Data/chat.db
  // -------------------------------------------------------------------------

  describe('LOCK-LIFE-1 — symlink/isolation guards', () => {
    it('rejects a symlinked candidate root before any DB open (root must be a real directory)', async () => {
      const root = getCandidateRoot(dataRoot)
      const external = path.join(dataRoot, 'external-target')
      fs.mkdirSync(external, { recursive: true })
      fs.symlinkSync(external, root, 'dir')

      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await expect(res.initialize()).rejects.toThrow(/isolation refused|symlink/)
      expect(res.getState()).toBe('new')
      // No candidate DB was ever created AND no leaf was ever created
      // through the symlink (LOCK-LIFE-1: no mkdir through an unvalidated
      // root) — the external target stays completely untouched.
      expect(fs.existsSync(path.join(external, `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`, 'chat.db'))).toBe(false)
      expect(fs.readdirSync(external)).toEqual([])
    })

    it('rejects initialization when the candidate root is a regular file (not a directory)', async () => {
      const root = getCandidateRoot(dataRoot)
      fs.mkdirSync(path.dirname(root), { recursive: true })
      fs.writeFileSync(root, 'not a directory', 'utf-8')

      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await expect(res.initialize()).rejects.toThrow(/isolation refused/)
      expect(res.getState()).toBe('new')
    })

    it('discard() fails closed when the candidate root became a symlink — no removal through the redirect (LOCK-LIFE-1)', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()

      // Replace the owned root with a symlink to an external target that
      // holds a same-named leaf. Without the root guard, rm(res.getCandidateDir())
      // would resolve through the link and delete the external leaf.
      const external = path.join(dataRoot, 'external-target')
      fs.mkdirSync(external, { recursive: true })
      const externalLeaf = path.join(external, `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`)
      fs.mkdirSync(externalLeaf, { recursive: true })
      fs.writeFileSync(path.join(externalLeaf, 'keep.txt'), 'x', 'utf-8')
      fs.rmSync(getCandidateRoot(dataRoot), { recursive: true, force: true })
      fs.symlinkSync(external, getCandidateRoot(dataRoot), 'dir')

      await expect(res.discard()).rejects.toThrow(/isolation refused/)
      // Cleanup never ran through the link: the external target is intact.
      expect(fs.existsSync(path.join(externalLeaf, 'keep.txt'))).toBe(true)
    })

    it('rejects a candidate leaf symlinked to the live data root — never reaches Data/chat.db', async () => {
      const leaf = path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`)
      fs.mkdirSync(path.dirname(leaf), { recursive: true })
      // The leaf IS a symlink to the live data root: opening leaf/chat.db
      // would resolve to the live Data/chat.db without this guard.
      fs.symlinkSync(dataRoot, leaf, 'dir')

      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await expect(res.initialize()).rejects.toThrow(/isolation refused|symlink/)
      expect(res.getState()).toBe('new')
      // The live DB path was never touched or created.
      expect(fs.existsSync(path.join(dataRoot, 'chat.db'))).toBe(false)
    })

    it('rejects a candidate leaf symlinked to an external directory outside the owned root', async () => {
      const leaf = path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`)
      fs.mkdirSync(path.dirname(leaf), { recursive: true })
      const external = path.join(dataRoot, 'external-target')
      fs.mkdirSync(external, { recursive: true })
      fs.symlinkSync(external, leaf, 'dir')

      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await expect(res.initialize()).rejects.toThrow(/isolation refused|symlink/)
      expect(res.getState()).toBe('new')
      // The external directory is untouched.
      expect(fs.readdirSync(external)).toEqual([])
    })

    it('accepts a normal (non-symlinked) temp-root candidate — realpath containment holds', async () => {
      // os.tmpdir() on darwin goes through /var → /private/var symlinks; the
      // realpath-based guard must still accept the ordinary owned layout.
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      expect(res.getState()).toBe('initialized')
      res.seal()
      expect(res.getState()).toBe('sealed')
    })
  })

  // -------------------------------------------------------------------------
  // LOCK-LIFE-2/3: seal fail-closed — FTS rebuild required; close failure is
  // seal failure; deferred/failed candidates stay discardable
  // -------------------------------------------------------------------------

  describe('seal fail-closed (LOCK-LIFE-2/3)', () => {
    it('seal() refuses a deferred-but-unrebuilt candidate and keeps it discardable', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      res.deferFtsProjection()
      expect(res.ftsProjection.getState()).toBe('deferred')

      expect(() => res.seal()).toThrow(/not rebuilt/)
      expect(res.getState()).toBe('initialized')
      expect(fs.existsSync(res.getDbPath())).toBe(true)

      // LOCK-LIFE-2: the unrebuilt candidate remains discardable.
      await res.discard()
      expect(res.getState()).toBe('discarded')
      expect(fs.existsSync(res.getCandidateDir())).toBe(false)
    })

    it('seal() succeeds only AFTER rebuild restores the projection', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      res.deferFtsProjection()
      expect(() => res.seal()).toThrow(/not rebuilt/)

      res.rebuildFtsProjection()
      expect(res.ftsProjection.getState()).toBe('rebuilt')
      res.seal()
      expect(res.getState()).toBe('sealed')
    })

    it('a failed defer leaves the candidate unsealable and discardable', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      const sqlite = res.getSqlite() as BetterSqlite3.Database
      // Replace the normalized table with a VIEW so the defer drop fails
      // (SQLite refuses DROP TABLE on a view) → helper enters failed.
      sqlite.exec('DROP TABLE message_blocks_normalized')
      sqlite.exec(
        "CREATE VIEW message_blocks_normalized AS SELECT 1 AS block_id, 1 AS message_id, 'x' AS normalized_content"
      )

      expect(() => res.deferFtsProjection()).toThrow(/defer failed/)
      expect(res.ftsProjection.getState()).toBe('failed')

      // LOCK-LIFE-2: a failed projection can never seal…
      expect(() => res.seal()).toThrow(/not rebuilt/)
      expect(res.getState()).toBe('initialized')
      // …and remains discardable (LOCK-FTS-4).
      await res.discard()
      expect(res.getState()).toBe('discarded')
    })

    it('a failed rebuild leaves the candidate unsealable and discardable', async () => {
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      const sqlite = res.getSqlite() as BetterSqlite3.Database
      // Seed canonical MAIN_TEXT content so the rebuild backfill actually
      // invokes chatdb_normalize (an empty candidate would skip it).
      sqlite.exec(`INSERT INTO topics (id, name, created_at) VALUES ('t1', 'Test', '2026-01-01T00:00:00.000Z')`)
      sqlite.exec(
        `INSERT INTO messages (id, topic_id, role, content, created_at, sort_order) ` +
          `VALUES ('m1', 't1', 'user', 'Hello', '2026-01-01T00:01:00.000Z', 0)`
      )
      sqlite.exec(
        `INSERT INTO message_blocks (id, message_id, type, content, sort_order) ` +
          `VALUES ('b1', 'm1', 'main_text', 'Hello world', 0)`
      )
      res.deferFtsProjection()
      expect(res.ftsProjection.getState()).toBe('deferred')

      // Force the rebuild backfill to fail mid-transaction (same arity as the
      // registered scalar — a zero-arity override is silently ignored by
      // better-sqlite3) → helper enters failed, nothing partially rebuilt.
      sqlite.function('chatdb_normalize', (content: string | null) => {
        throw new Error(`normalize boom: ${typeof content}`)
      })
      expect(() => res.rebuildFtsProjection()).toThrow(/rebuild failed/)

      expect(res.ftsProjection.getState()).toBe('failed')
      expect(() => res.seal()).toThrow(/not rebuilt/)
      expect(res.getState()).toBe('initialized')

      await res.discard()
      expect(res.getState()).toBe('discarded')
    })

    it('seal() fails closed when close() returns false — ownership/state retained (LOCK-LIFE-3)', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.close = vi.fn(() => false) // close-busy semantics
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: () => fake })
      await res.initialize()
      const sealAttemptClose = fake.close

      expect(() => res.seal()).toThrow(/close returned false/)
      // Never marked sealed; ownership retained for failure/discard handling.
      expect(res.getState()).toBe('initialized')
      expect(res.getService()).toBeDefined()
      expect(sealAttemptClose).toHaveBeenCalledTimes(1)

      // A later successful close + discard cleans up normally.
      fake.close = vi.fn(() => true)
      const discardClose = fake.close
      await res.discard()
      expect(res.getState()).toBe('discarded')
      expect(discardClose).toHaveBeenCalledTimes(1)
    })

    it('seal() fails closed when close() throws — ownership/state retained (LOCK-LIFE-3)', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.close = vi.fn(() => {
        throw new Error('close boom')
      })
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: () => fake })
      await res.initialize()

      expect(() => res.seal()).toThrow(/close error/)
      expect(res.getState()).toBe('initialized')

      // Discard retries the close best-effort and still removes the dir.
      fake.close = vi.fn(() => true)
      await expect(res.discard()).resolves.not.toThrow()
      expect(res.getState()).toBe('discarded')
    })

    it('a sealed candidate without deferral still seals (idle projection is intact)', async () => {
      // Never deferred → migration-003 projection intact → seal is legal.
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
      await res.initialize()
      expect(res.ftsProjection.getState()).toBe('idle')
      res.seal()
      expect(res.getState()).toBe('sealed')
    })
  })

  // -------------------------------------------------------------------------
  // LOCK-LIFE-3: close false/throw NEVER abandons a handle — retained in the
  // init-failure cleanup and in best-effort discard close, so ownership is
  // never claimed gone while the close failed
  // -------------------------------------------------------------------------

  describe('close-failure retention (LOCK-LIFE-3)', () => {
    it('a failed initialize() whose cleanup close() returns false retains the handle for disposal', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(async () => {
        throw new Error('init boom')
      })
      let closeCalls = 0
      fake.close = vi.fn((): boolean => {
        closeCalls++
        return false // close-busy semantics
      })
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      await expect(res.initialize()).rejects.toThrow('init boom')
      // The cleanup close was attempted but the handle was NOT abandoned.
      expect(closeCalls).toBe(1)
      expect(res.getState()).toBe('new')

      // Disposal retries the close; once it succeeds the handle is released.
      fake.close = vi.fn((): boolean => {
        closeCalls++
        return true
      })
      await res.discard()
      expect(res.getState()).toBe('discarded')
      expect(closeCalls).toBe(2)
    })

    it('a failed initialize() whose cleanup close() throws retains the handle for disposal', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(async () => {
        throw new Error('init boom')
      })
      let closeCalls = 0
      fake.close = vi.fn((): boolean => {
        closeCalls++
        throw new Error('close boom')
      })
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      await expect(res.initialize()).rejects.toThrow('init boom')
      expect(closeCalls).toBe(1)
      expect(res.getState()).toBe('new')

      // Disposal retries the close; once it succeeds the handle is released.
      fake.close = vi.fn((): boolean => {
        closeCalls++
        return true
      })
      await res.discard()
      expect(res.getState()).toBe('discarded')
      expect(closeCalls).toBe(2)
    })

    it('a fresh initialize() retry is refused while a failed close retains an open handle — no double handle', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(async () => {
        throw new Error('init boom')
      })
      fake.close = vi.fn(() => false)
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      await expect(res.initialize()).rejects.toThrow('init boom')
      // The retained handle must never be duplicated by a second factory call.
      await expect(res.initialize()).rejects.toThrow(/retry refused/)
      expect(factory).toHaveBeenCalledTimes(1)

      // Disposal releases it.
      fake.close = vi.fn(() => true)
      await res.discard()
      expect(res.getState()).toBe('discarded')
    })

    it('discard() with a failing close() retains the handle — ownership is not claimed gone while close failed', async () => {
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: () => fake })
      await res.initialize()

      let closeCalls = 0
      fake.close = vi.fn((): boolean => {
        closeCalls++
        return false
      })
      await res.discard()
      expect(res.getState()).toBe('discarded')
      expect(closeCalls).toBe(1)

      // The handle was retained (close failed) — a second discard retries it.
      fake.close = vi.fn((): boolean => {
        closeCalls++
        return true
      })
      await res.discard()
      expect(closeCalls).toBe(2)
      expect(res.getState()).toBe('discarded')
    })
  })

  // -------------------------------------------------------------------------
  // LOCK-LIFE-4: initialize() is concurrency-safe / idempotent — concurrent
  // callers share one promise; a failed init leaks no service handle
  // -------------------------------------------------------------------------

  describe('concurrent initialize (LOCK-LIFE-4)', () => {
    it('concurrent callers share ONE in-flight promise — factory invoked exactly once', async () => {
      let resolveInit: () => void
      const gate = new Promise<void>((r) => {
        resolveInit = r
      })
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(() => gate)
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      const p1 = res.initialize()
      const p2 = res.initialize()
      const p3 = res.initialize()
      // All three callers share the single in-flight init — no second service.
      expect(factory).toHaveBeenCalledTimes(1)

      resolveInit!()
      await Promise.all([p1, p2, p3])
      expect(factory).toHaveBeenCalledTimes(1)
      expect(fake.init).toHaveBeenCalledTimes(1)
      expect(res.getState()).toBe('initialized')

      await res.discard()
    })

    it('a failed initialize() closes the partially-initialized service (no leaked handle) and allows retry', async () => {
      let calls = 0
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(async () => {
        calls++
        if (calls === 1) {
          throw new Error('init boom')
        }
        // Second call succeeds like the real service.
        fs.mkdirSync(path.dirname(fake.getDbPath()), { recursive: true })
        fs.writeFileSync(fake.getDbPath(), '', 'utf-8')
      })
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      await expect(res.initialize()).rejects.toThrow('init boom')
      // The failed service handle was closed — nothing leaked.
      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(res.getState()).toBe('new')
      expect(factory).toHaveBeenCalledTimes(1)

      // Fresh retry on the same resource succeeds (serialized, not stuck).
      await res.initialize()
      expect(res.getState()).toBe('initialized')
      expect(factory).toHaveBeenCalledTimes(2)
      await res.discard()
    })

    it('a concurrent caller awaiting a FAILED init shares the rejection and no service leaks', async () => {
      let rejectInit: (error: Error) => void
      const gate = new Promise<void>((_, r) => {
        rejectInit = r
      })
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(() => gate)
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      const p1 = res.initialize()
      const p2 = res.initialize()
      expect(factory).toHaveBeenCalledTimes(1)

      rejectInit!(new Error('init boom'))
      await expect(p1).rejects.toThrow('init boom')
      await expect(p2).rejects.toThrow('init boom')
      // The handle was closed exactly once (shared failure path).
      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(res.getState()).toBe('new')
    })

    it('discard() during a blocked initialize serializes behind it, ends discarded, and never publishes (LOCK-LIFE-4)', async () => {
      let resolveInit: () => void
      const gate = new Promise<void>((r) => {
        resolveInit = r
      })
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(() => gate)
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      const initP = res.initialize()
      const discardP = res.discard()
      let discardSettled = false
      void discardP.then(() => {
        discardSettled = true
      })
      // Give discard a microtask tick: it must be serialized behind the
      // blocked init — not settled, no removal while init is mid-flight.
      await Promise.resolve()
      expect(discardSettled).toBe(false)
      expect(factory).toHaveBeenCalledTimes(1)

      resolveInit!()
      await Promise.all([initP, discardP])

      // Init's publication was cancelled by teardown: the resource ends
      // discarded with no service published after teardown and the handle
      // closed exactly once (from the cancelled publication).
      expect(res.getState()).toBe('discarded')
      expect(factory).toHaveBeenCalledTimes(1)
      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(fs.existsSync(res.getCandidateDir())).toBe(false)
    })

    it('discard() during a blocked initialize that then FAILS still ends discarded (LOCK-LIFE-4)', async () => {
      let rejectInit: (error: Error) => void
      const gate = new Promise<void>((_, r) => {
        rejectInit = r
      })
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(() => gate)
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      const initP = res.initialize()
      const discardP = res.discard()

      rejectInit!(new Error('init boom'))
      await expect(initP).rejects.toThrow('init boom')
      // Discard absorbs the failed init and still cleans up.
      await expect(discardP).resolves.not.toThrow()
      expect(res.getState()).toBe('discarded')
      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(fs.existsSync(res.getCandidateDir())).toBe(false)
    })

    it('discardSync() during a blocked initialize cancels publication — no service after teardown, no leaked handle (LOCK-LIFE-4)', async () => {
      let resolveInit: () => void
      const gate = new Promise<void>((r) => {
        resolveInit = r
      })
      const fake = makeFakeService(path.join(getCandidateRoot(dataRoot), `${CANDIDATE_DIR_PREFIX}${VALID_SESSION_ID}`))
      fake.init = vi.fn(() => gate)
      const factory = vi.fn(() => fake)
      const res = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot, chatDbServiceFactory: factory })

      const initP = res.initialize()
      expect(factory).toHaveBeenCalledTimes(1)

      // Sync teardown while init is blocked.
      res.discardSync()
      expect(res.getState()).toBe('discarded')

      resolveInit!()
      await initP
      // Init settled WITHOUT publishing a service after teardown; the
      // cancelled handle was closed (no leak).
      expect(res.getState()).toBe('discarded')
      expect(fake.close).toHaveBeenCalledTimes(1)
      expect(fs.existsSync(res.getCandidateDir())).toBe(false)
    })

    it('initialize() is refused once teardown was requested (LOCK-LIFE-4)', async () => {
      const res = new CandidateDbResource({
        sessionId: VALID_SESSION_ID,
        dataRoot,
        chatDbServiceFactory: (dbDir) => makeFakeService(dbDir)
      })
      await res.initialize()
      const discardP = res.discard()
      // During teardown, a stray initialize must not start a new service.
      await expect(res.initialize()).rejects.toThrow(/teardown/)
      await discardP
      expect(res.getState()).toBe('discarded')
    })
  })
})

// ---------------------------------------------------------------------------
// Reseal — post-verification sealed-invariant restoration (LOCK-RS3/RS6)
// ---------------------------------------------------------------------------

describe('candidateDb — reseal after readonly verification residue (LOCK-RS3)', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = makeDataRoot()
  })

  afterEach(() => {
    rmrf(dataRoot)
    vi.restoreAllMocks()
  })

  /** Create a real sealed candidate with one topic row, then close (sealed). */
  async function makeRealSealedResource(): Promise<{
    resource: CandidateDbResource
    dbPath: string
  }> {
    const resource = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
    await resource.initialize() // real ChatDbService + real migrations
    const sqlite = resource.getSqlite() as BetterSqlite3.Database
    sqlite.prepare("INSERT INTO topics (id, name) VALUES ('t1', 'x')").run()
    resource.seal()
    // A clean writable close leaves NO sidecars (sealed invariant).
    const dbPath = resource.getDbPath()
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    return { resource, dbPath }
  }

  /** Recreate the verifier's readonly residue: readonly open + close. */
  function leaveReadonlyResidue(dbPath: string): void {
    const readonly = new Database(dbPath, { readonly: true, fileMustExist: true })
    readonly.prepare('SELECT count(*) AS c FROM topics').get()
    readonly.close()
    // 0-byte -wal + empty 32KiB -shm residue (inspector-proven shape).
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true)
    expect(fs.statSync(`${dbPath}-wal`).size).toBe(0)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(true)
  }

  it('reseal removes readonly residue, keeps main bytes stable, stays readable, and is idempotent', async () => {
    const { resource, dbPath } = await makeRealSealedResource()
    const mainBytesAtSeal = fs.statSync(dbPath).size

    // Phase 4.3 verifier: readonly reopen leaves empty WAL/SHM residue.
    leaveReadonlyResidue(dbPath)

    // Reseal restores the sealed invariant without touching main bytes.
    resource.reseal()
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    expect(fs.statSync(dbPath).size).toBe(mainBytesAtSeal)
    expect(resource.getState()).toBe('sealed')

    // Readable after reseal (candidate remains a valid DB for promotion).
    const reread = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = reread.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
    expect(row.c).toBe(1)
    reread.close()

    // Idempotent: a second reseal on the clean sealed candidate succeeds.
    resource.reseal()
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('module-level resealSealedCandidate restores the sealed invariant on a raw candidate path', async () => {
    const { dbPath } = await makeRealSealedResource()
    const mainBytesAtSeal = fs.statSync(dbPath).size

    leaveReadonlyResidue(dbPath)
    resealSealedCandidate(dbPath)

    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    expect(fs.statSync(dbPath).size).toBe(mainBytesAtSeal)
  })

  it('reseal fails closed when the candidate DB is missing (no silent file creation)', async () => {
    const { resource, dbPath } = await makeRealSealedResource()
    // Remove the candidate DB after seal — the sealed invariant is gone.
    fs.rmSync(dbPath)

    expect(() => resource.reseal()).toThrow(/not a file/)
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('reseal refuses from non-sealed states (new / initialized)', async () => {
    const fresh = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
    expect(() => fresh.reseal()).toThrow(/not sealed/)

    const open = new CandidateDbResource({ sessionId: VALID_SESSION_ID, dataRoot })
    await open.initialize()
    expect(() => open.reseal()).toThrow(/not sealed/)
  })

  it('reseal fails closed when a sidecar survives the checkpoint — no blind unlink', async () => {
    const { resource, dbPath } = await makeRealSealedResource()
    leaveReadonlyResidue(dbPath)

    // Inject a surviving -wal sidecar: make the post-checkpoint existence
    // probe report the WAL as present so the fail-closed branch is taken.
    const existsSpy = vi.spyOn(nodeFs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('-wal')) return true
      return fs.existsSync(p)
    })

    expect(() => resource.reseal()).toThrow(/still present after checkpoint/)
    existsSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Lightweight CandidateDbService double that creates the owned directory and
 * an empty chat.db file (so path-level assertions hold) without running real
 * migrations. Used where the test focuses on lifecycle bookkeeping rather
 * than SQLite behavior.
 */
function makeFakeService(dbDir: string) {
  const dbPath = path.join(dbDir, 'chat.db')
  let initialised = false
  return {
    init: vi.fn(async () => {
      fs.mkdirSync(dbDir, { recursive: true })
      fs.writeFileSync(dbPath, '', 'utf-8')
      initialised = true
    }),
    close: vi.fn((): boolean => {
      initialised = false
      return true
    }),
    getDatabase: vi.fn(() => ({})),
    getSqlite: vi.fn(() => ({})),
    getDbDir: vi.fn(() => dbDir),
    getDbPath: vi.fn(() => dbPath),
    isInitialised: vi.fn(() => initialised)
  }
}
