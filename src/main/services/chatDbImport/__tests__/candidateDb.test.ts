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
import * as os from 'node:os'
import * as path from 'node:path'

import type BetterSqlite3 from 'better-sqlite3'
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
  recoverOrphanedCandidates
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

    it('is a no-op when the candidate root does not exist', async () => {
      // Fresh dataRoot with no candidate root yet.
      await expect(recoverOrphanedCandidates(dataRoot)).resolves.not.toThrow()
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
    close: vi.fn(() => {
      initialised = false
    }),
    getDatabase: vi.fn(() => ({})),
    getSqlite: vi.fn(() => ({})),
    getDbDir: vi.fn(() => dbDir),
    getDbPath: vi.fn(() => dbPath),
    isInitialised: vi.fn(() => initialised)
  }
}
