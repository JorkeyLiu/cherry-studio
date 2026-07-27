/**
 * Read-only promotion artifact probe tests (Phase 4.4.3, LOCK-4431/LOCK-4432).
 *
 * Proves:
 * - Deterministic live/snapshot/candidate statuses for decidePromotionRecovery()
 * - Controlled no-residue strategy: sidecars may be created during readonly
 *   probes but are cleaned up, leaving zero net filesystem mutations
 * - Structured error details for stat I/O and validation failures
 * - CandidateId validation before path resolution (LOCK-4434)
 * - Real better-sqlite3 probes: empty valid DB, invalid/corrupt/migration/FK/sample failures
 * - Dynamic before/after directory assertion: no uncleaned residue remains
 * - Integration with decidePromotionRecovery()
 *
 * Uses real better-sqlite3 databases in temporary directories. No mocks
 * except DATA_PATH. Tests run on actual filesystem.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { CANDIDATE_ROOT_DIRNAME } from '../../candidateDb'
import {
  diffDirectorySnapshots,
  probeCandidate,
  probeLiveDb,
  probePromotionArtifacts,
  probeResultToRecoveryInput,
  probeRetainedSnapshot,
  resolveCandidateDbPath,
  resolveLiveDbPath,
  resolveRetainedSnapshotPath,
  snapshotDirectory
} from '../artifactProbe'
import { PROMOTION_JOURNAL_FILENAME, ROLLBACK_SNAPSHOT_FILENAME } from '../journal'
import { PROMOTION_JOURNAL_PHASES } from '../journal'
import { decidePromotionRecovery } from '../recovery'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-artifact-probe-'))
}

/** Create + migrate a fresh valid chat.db (empty, zero rows) and close it. */
function makeValidDb(dir: string): string {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  sqlite.close()
  // Clean up any sidecars from the write session
  cleanupWalFiles(dbPath)
  return dbPath
}

/** Create + migrate + seed a live chat.db and close it. */
function makeSeededDb(dir: string): string {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  seed(sqlite)
  sqlite.close()
  // Clean up any sidecars from the write session
  cleanupWalFiles(dbPath)
  return dbPath
}

function cleanupWalFiles(dbPath: string): void {
  try {
    realFs.unlinkSync(`${dbPath}-wal`)
  } catch {
    /* ok */
  }
  try {
    realFs.unlinkSync(`${dbPath}-shm`)
  } catch {
    /* ok */
  }
}

function seed(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES
      ('t-1', 'a-1', 'Topic 1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}'),
      ('t-2', 'a-1', 'Topic 2', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}');
    INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES
      ('m-1', 't-1', 'user', 'hello', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}'),
      ('m-2', 't-1', 'assistant', 'world', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:02.000Z', '2020-01-01T00:00:02.000Z', 1, '{}');
    INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES
      ('b-1', 'm-1', 'main_text', 'hi', 'success', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
    INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES
      ('s-1', 't-1', 'Segment 1', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 0, '{}');
    INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES
      ('s-1', 'm-1', 0),
      ('s-1', 'm-2', 1);
  `)
}

/**
 * Corrupt the database by replacing the entire file with garbage bytes.
 * This deterministically breaks SQLite's ability to open the file,
 * causing validateReadonlyChatDb to fail at the 'open' or 'integrity' gate.
 */
function corruptDbToGarbage(dbPath: string): void {
  realFs.writeFileSync(dbPath, 'not-a-valid-sqlite-database-file-garbage-bytes')
}

/** Write a promotion journal file at the given directory. */
function writeJournal(dir: string, journal: object): void {
  realFs.writeFileSync(realPath.join(dir, PROMOTION_JOURNAL_FILENAME), JSON.stringify(journal), 'utf-8')
}

/** Create the candidate directory structure. */
function makeCandidateDir(dataRoot: string, candidateId: string): string {
  const dir = realPath.join(dataRoot, CANDIDATE_ROOT_DIRNAME, candidateId)
  realFs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Assert that a DB file has no WAL/SHM sidecars after probing.
 * Probes create and clean sidecars, so after probe returns there should
 * be no residue.
 */
function expectNoSidecarResidue(dbPath: string): void {
  expect(realFs.existsSync(`${dbPath}-wal`)).toBe(false)
  expect(realFs.existsSync(`${dbPath}-shm`)).toBe(false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('artifactProbe (Phase 4.4.3, LOCK-4431/LOCK-4432)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------------

  describe('path resolution (LOCK-4434)', () => {
    it('resolveLiveDbPath returns dataRoot/chat.db', () => {
      expect(resolveLiveDbPath('/data')).toBe(realPath.resolve('/data/chat.db'))
    })

    it('resolveRetainedSnapshotPath returns dataRoot/chat.db.pre-import-backup', () => {
      expect(resolveRetainedSnapshotPath('/data')).toBe(realPath.resolve('/data/chat.db.pre-import-backup'))
    })

    it('resolveCandidateDbPath returns dataRoot/chat-import-candidates/<id>/chat.db', () => {
      expect(resolveCandidateDbPath('candidate-s1', '/data')).toBe(
        realPath.resolve('/data/chat-import-candidates/candidate-s1/chat.db')
      )
    })
  })

  // -------------------------------------------------------------------------
  // Directory snapshot utilities
  // -------------------------------------------------------------------------

  describe('directory snapshot utilities', () => {
    it('snapshotDirectory captures entries and total bytes', () => {
      realFs.writeFileSync(realPath.join(tempDir, 'a.txt'), 'hello')
      realFs.writeFileSync(realPath.join(tempDir, 'b.txt'), 'world!')
      const snap = snapshotDirectory(tempDir)
      expect(snap.entries).toEqual(['a.txt', 'b.txt'])
      expect(snap.totalBytes).toBe(11) // 5 + 6
    })

    it('snapshotDirectory returns empty for non-existent directory', () => {
      const snap = snapshotDirectory(realPath.join(tempDir, 'nope'))
      expect(snap.entries).toEqual([])
      expect(snap.totalBytes).toBe(0)
    })

    it('diffDirectorySnapshots detects added and removed entries', () => {
      const before = snapshotDirectory(tempDir)
      realFs.writeFileSync(realPath.join(tempDir, 'new.txt'), 'data')
      const after = snapshotDirectory(tempDir)
      const diff = diffDirectorySnapshots(before, after)
      expect(diff.added).toEqual(['new.txt'])
      expect(diff.removed).toEqual([])
    })

    it('diffDirectorySnapshots detects removed entries', () => {
      realFs.writeFileSync(realPath.join(tempDir, 'gone.txt'), 'data')
      const before = snapshotDirectory(tempDir)
      realFs.unlinkSync(realPath.join(tempDir, 'gone.txt'))
      const after = snapshotDirectory(tempDir)
      const diff = diffDirectorySnapshots(before, after)
      expect(diff.added).toEqual([])
      expect(diff.removed).toEqual(['gone.txt'])
    })
  })

  // -------------------------------------------------------------------------
  // Live DB probe
  // -------------------------------------------------------------------------

  describe('probeLiveDb', () => {
    it('returns missing for non-existent live DB', () => {
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('missing')
      expect(result.detail).toBeNull()
    })

    it('returns present-verified for an empty valid migrated DB', () => {
      makeValidDb(tempDir)
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-verified')
      expect(result.detail).toBeNull()
      expectNoSidecarResidue(realPath.join(tempDir, 'chat.db'))
    })

    it('returns present-verified for a seeded valid DB', () => {
      makeSeededDb(tempDir)
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-verified')
      expect(result.detail).toBeNull()
      expectNoSidecarResidue(realPath.join(tempDir, 'chat.db'))
    })

    it('returns present-unverified with stat-failure for a directory at the live path', () => {
      realFs.mkdirSync(realPath.join(tempDir, 'chat.db'))
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail).toEqual({ kind: 'stat-failure', code: 'NOT_A_FILE' })
    })

    it('returns present-unverified for corrupted DB (open/integrity failure)', () => {
      const dbPath = makeValidDb(tempDir)
      corruptDbToGarbage(dbPath)
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail?.kind).toBe('validation-failure')
      if (result.detail?.kind === 'validation-failure') {
        // better-sqlite3 may open the garbage file (gate: 'integrity') or
        // fail to open it (gate: 'open') — both are validation failures.
        expect(['open', 'integrity']).toContain(result.detail.gate)
      }
      expectNoSidecarResidue(dbPath)
    })

    it('returns present-unverified for FK violation', () => {
      const dbPath = makeValidDb(tempDir)
      const sqlite = new Database(dbPath)
      sqlite.pragma('foreign_keys = OFF')
      sqlite.prepare(`INSERT INTO messages (id, topic_id, sort_order) VALUES ('m-orphan', 't-missing', 0)`).run()
      sqlite.close()
      cleanupWalFiles(dbPath)
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail?.kind).toBe('validation-failure')
      if (result.detail?.kind === 'validation-failure') {
        expect(result.detail.gate).toBe('foreign-keys')
      }
      expectNoSidecarResidue(dbPath)
    })

    it('returns present-unverified for migration incompatibility', () => {
      const dbPath = makeValidDb(tempDir)
      const sqlite = new Database(dbPath)
      sqlite.prepare(`DELETE FROM migration_state WHERE key = '002_corrective_schema'`).run()
      sqlite.close()
      cleanupWalFiles(dbPath)
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail?.kind).toBe('validation-failure')
      if (result.detail?.kind === 'validation-failure') {
        expect(result.detail.gate).toBe('migration')
      }
      expectNoSidecarResidue(dbPath)
    })

    it('returns present-unverified for sample-read failure (missing table)', () => {
      const dbPath = realPath.join(tempDir, 'chat.db')
      // Create a database from scratch without the topic_segment_messages table
      // so that sample reads that reference it will fail.
      const sqlite = new Database(dbPath)
      sqlite.pragma('journal_mode = WAL')
      sqlite.pragma('foreign_keys = ON')
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS migration_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO migration_state (key, value, updated_at) VALUES
          ('001_initial_schema', '001_initial_schema', '2020-01-01T00:00:00.000Z'),
          ('002_corrective_schema', '002_corrective_schema', '2020-01-01T00:00:00.000Z');
        CREATE TABLE IF NOT EXISTS topics (
          id TEXT PRIMARY KEY,
          assistant_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          extra TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES topics(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          ask_id TEXT,
          model TEXT,
          model_id TEXT,
          assistant_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          extra TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS message_blocks (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id),
          type TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          extra TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS topic_segments (
          id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL REFERENCES topics(id),
          name TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          extra TEXT NOT NULL DEFAULT '{}'
        );
        -- NOTE: topic_segment_messages is intentionally MISSING
        INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES
          ('t-1', 'a-1', 'Topic 1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}');
        INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES
          ('m-1', 't-1', 'user', 'hello', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
        INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES
          ('s-1', 't-1', 'Segment 1', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 0, '{}');
      `)
      sqlite.close()
      cleanupWalFiles(dbPath)
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail?.kind).toBe('validation-failure')
      if (result.detail?.kind === 'validation-failure') {
        expect(result.detail.gate).toBe('sample-reads')
      }
      expectNoSidecarResidue(dbPath)
    })

    it('cleans up sidecars created during probe (no-residue)', () => {
      makeSeededDb(tempDir)
      const dbPath = realPath.join(tempDir, 'chat.db')
      const before = snapshotDirectory(tempDir)
      probeLiveDb(tempDir)
      const after = snapshotDirectory(tempDir)
      const diff = diffDirectorySnapshots(before, after)
      // No net additions (sidecars cleaned up)
      expect(diff.added).toEqual([])
      expectNoSidecarResidue(dbPath)
    })
  })

  // -------------------------------------------------------------------------
  // Retained snapshot probe
  // -------------------------------------------------------------------------

  describe('probeRetainedSnapshot', () => {
    it('returns missing for non-existent snapshot', () => {
      const result = probeRetainedSnapshot(tempDir)
      expect(result.status).toBe('missing')
      expect(result.detail).toBeNull()
    })

    it('returns present-verified for a valid snapshot', () => {
      makeValidDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      realFs.renameSync(realPath.join(tempDir, 'chat.db'), snapshotPath)
      const result = probeRetainedSnapshot(tempDir)
      expect(result.status).toBe('present-verified')
      expect(result.detail).toBeNull()
      expectNoSidecarResidue(snapshotPath)
    })

    it('returns present-unverified for a corrupted snapshot', () => {
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      realFs.writeFileSync(snapshotPath, 'not-a-sqlite-file')
      const result = probeRetainedSnapshot(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail?.kind).toBe('validation-failure')
      expectNoSidecarResidue(snapshotPath)
    })

    it('cleans up sidecars after probing (no-residue)', () => {
      makeValidDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      realFs.renameSync(realPath.join(tempDir, 'chat.db'), snapshotPath)
      const before = snapshotDirectory(tempDir)
      probeRetainedSnapshot(tempDir)
      const after = snapshotDirectory(tempDir)
      const diff = diffDirectorySnapshots(before, after)
      expect(diff.added).toEqual([])
      expectNoSidecarResidue(snapshotPath)
    })
  })

  // -------------------------------------------------------------------------
  // Candidate probe
  // -------------------------------------------------------------------------

  describe('probeCandidate', () => {
    it('returns missing for non-existent candidate', () => {
      const result = probeCandidate('candidate-s1', tempDir)
      expect(result).toEqual({ status: 'missing' })
    })

    it('returns present for an existing candidate', () => {
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      const result = probeCandidate('candidate-s1', tempDir)
      expect(result).toEqual({ status: 'present' })
    })

    it('returns error for unsafe candidateId (path traversal)', () => {
      const result = probeCandidate('../etc/passwd', tempDir)
      expect(result).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('returns error for candidateId with dots', () => {
      const result = probeCandidate('candidate.s1', tempDir)
      expect(result).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('returns error for candidateId with forward slash', () => {
      const result = probeCandidate('candidate/s1', tempDir)
      expect(result).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('returns error for candidateId without the owned prefix', () => {
      const result = probeCandidate('session-s1', tempDir)
      expect(result).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('returns error for empty candidateId', () => {
      const result = probeCandidate('', tempDir)
      expect(result).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })
  })

  // -------------------------------------------------------------------------
  // Composite probe — full artifact status matrix
  // -------------------------------------------------------------------------

  describe('probePromotionArtifacts', () => {
    it('returns all-missing for an empty data root', () => {
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('absent')
      expect(result.live.status).toBe('missing')
      expect(result.snapshot.status).toBe('missing')
      expect(result.candidate.status).toBe('missing')
      expect(result.sidecarFree).toBe(true)
      expect(result.mutationEvidence.added).toEqual([])
      expect(result.mutationEvidence.removed).toEqual([])
    })

    it('returns present-verified for live DB only', () => {
      makeSeededDb(tempDir)
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('absent')
      expect(result.live.status).toBe('present-verified')
      expect(result.snapshot.status).toBe('missing')
      expect(result.candidate.status).toBe('missing')
      expect(result.sidecarFree).toBe(true)
      expectNoSidecarResidue(realPath.join(tempDir, 'chat.db'))
    })

    it('returns valid journal + present-verified live + candidate', () => {
      makeSeededDb(tempDir)
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'snapshot-ready'
      })
      const result = probePromotionArtifacts('candidate-s1', tempDir)
      expect(result.journal.status).toBe('valid')
      expect(result.live.status).toBe('present-verified')
      expect(result.snapshot.status).toBe('missing')
      expect(result.candidate.status).toBe('present')
      expect(result.sidecarFree).toBe(true)
      expectNoSidecarResidue(realPath.join(tempDir, 'chat.db'))
    })

    it('returns invalid journal + present-verified live + candidate missing', () => {
      makeSeededDb(tempDir)
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      writeJournal(tempDir, { garbage: true })
      const result = probePromotionArtifacts('candidate-s1', tempDir)
      expect(result.journal.status).toBe('invalid')
      expect(result.live.status).toBe('present-verified')
      expect(result.candidate.status).toBe('missing') // Invalid journal → candidate not resolved
      expect(result.sidecarFree).toBe(true)
    })

    it('creates no uncleaned filesystem mutations for any probe combination', () => {
      // Set up a complex state
      makeSeededDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      const dbPath = realPath.join(tempDir, 'chat.db')
      realFs.copyFileSync(dbPath, snapshotPath)
      cleanupWalFiles(snapshotPath)
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'candidate-installed'
      })

      const result = probePromotionArtifacts('candidate-s1', tempDir)

      // Sidecar-free (all created sidecars were cleaned up)
      expect(result.sidecarFree).toBe(true)
      // No net additions or removals of any files
      expect(result.mutationEvidence.added).toEqual([])
      expect(result.mutationEvidence.removed).toEqual([])
      // No residue on any DB file
      expectNoSidecarResidue(dbPath)
      expectNoSidecarResidue(snapshotPath)
    })

    it('detects sidecar creation if it ever occurs (safety belt)', () => {
      // This test ensures the detection mechanism works — in practice
      // better-sqlite3 readonly mode creates and then we clean them.
      makeValidDb(tempDir)
      const before = snapshotDirectory(tempDir)

      // Simulate sidecar creation (not from the probe, but for detection testing)
      realFs.writeFileSync(realPath.join(tempDir, 'chat.db-wal'), 'fake')
      realFs.writeFileSync(realPath.join(tempDir, 'chat.db-shm'), 'fake')

      const after = snapshotDirectory(tempDir)
      const diff = diffDirectorySnapshots(before, after)

      // The detection mechanism should catch these
      expect(diff.added).toContain('chat.db-wal')
      expect(diff.added).toContain('chat.db-shm')

      // Cleanup the fake sidecars
      realFs.unlinkSync(realPath.join(tempDir, 'chat.db-wal'))
      realFs.unlinkSync(realPath.join(tempDir, 'chat.db-shm'))
    })
  })

  // -------------------------------------------------------------------------
  // Integration with decidePromotionRecovery
  // -------------------------------------------------------------------------

  describe('integration with decidePromotionRecovery', () => {
    it('maps probe results to recovery input correctly', () => {
      const result = probePromotionArtifacts(null, tempDir)
      const input = probeResultToRecoveryInput(result)
      expect(input).toEqual({
        journal: { status: 'absent' },
        live: 'missing',
        snapshot: 'missing',
        candidate: 'missing'
      })
    })

    it('correct recovery decision for no journal (keep-old-live)', () => {
      const result = probePromotionArtifacts(null, tempDir)
      const input = probeResultToRecoveryInput(result)
      const decision = decidePromotionRecovery(input)
      expect(decision).toEqual({ action: 'keep-old-live', reason: 'NO_JOURNAL' })
    })

    it('correct recovery decision for invalid journal (repair-required)', () => {
      writeJournal(tempDir, { garbage: true })
      const result = probePromotionArtifacts(null, tempDir)
      const input = probeResultToRecoveryInput(result)
      const decision = decidePromotionRecovery(input)
      expect(decision).toEqual({ action: 'repair-required', reason: 'JOURNAL_INVALID' })
    })

    it('correct recovery decision for snapshot-ready + live present + candidate present', () => {
      makeSeededDb(tempDir)
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'snapshot-ready'
      })
      const result = probePromotionArtifacts('candidate-s1', tempDir)
      const input = probeResultToRecoveryInput(result)
      const decision = decidePromotionRecovery(input)
      expect(decision.action).toBe('keep-old-live')
      expect(decision.reason).toBe('SNAPSHOT_READY_INSTALL_NOT_STARTED')
    })

    it('correct recovery decision for replacement-verified + live verified', () => {
      makeSeededDb(tempDir)
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'replacement-verified'
      })
      const result = probePromotionArtifacts('candidate-s1', tempDir)
      const input = probeResultToRecoveryInput(result)
      const decision = decidePromotionRecovery(input)
      expect(decision.action).toBe('accept-verified-replacement')
      expect(decision.reason).toBe('REPLACEMENT_VERIFIED_LIVE_VERIFIED')
    })
  })

  // -------------------------------------------------------------------------
  // Sidecar-free invariant — comprehensive proof
  // -------------------------------------------------------------------------

  describe('sidecar-free invariant', () => {
    it('probes an empty valid DB without leaving sidecar residue', () => {
      const dbPath = makeValidDb(tempDir)
      probeLiveDb(tempDir)
      expectNoSidecarResidue(dbPath)
    })

    it('probes a seeded DB without leaving sidecar residue', () => {
      const dbPath = makeSeededDb(tempDir)
      probeLiveDb(tempDir)
      expectNoSidecarResidue(dbPath)
    })

    it('probes a corrupted DB without leaving sidecar residue', () => {
      const dbPath = makeValidDb(tempDir)
      corruptDbToGarbage(dbPath)
      probeLiveDb(tempDir)
      expectNoSidecarResidue(dbPath)
    })

    it('probes a DB with FK violations without leaving sidecar residue', () => {
      const dbPath = makeValidDb(tempDir)
      const sqlite = new Database(dbPath)
      sqlite.pragma('foreign_keys = OFF')
      sqlite.prepare(`INSERT INTO messages (id, topic_id, sort_order) VALUES ('m-orphan', 't-missing', 0)`).run()
      sqlite.close()
      cleanupWalFiles(dbPath)
      probeLiveDb(tempDir)
      expectNoSidecarResidue(dbPath)
    })

    it('probes a DB with migration incompatibility without leaving sidecar residue', () => {
      const dbPath = makeValidDb(tempDir)
      const sqlite = new Database(dbPath)
      sqlite.prepare(`DELETE FROM migration_state WHERE key = '002_corrective_schema'`).run()
      sqlite.close()
      cleanupWalFiles(dbPath)
      probeLiveDb(tempDir)
      expectNoSidecarResidue(dbPath)
    })

    it('probes a snapshot without leaving sidecar residue', () => {
      makeValidDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      realFs.renameSync(realPath.join(tempDir, 'chat.db'), snapshotPath)
      probeRetainedSnapshot(tempDir)
      expectNoSidecarResidue(snapshotPath)
    })

    it('composite probe leaves no sidecar residue across all artifacts', () => {
      makeSeededDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      realFs.copyFileSync(realPath.join(tempDir, 'chat.db'), snapshotPath)
      cleanupWalFiles(snapshotPath)
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'snapshot-ready'
      })

      const result = probePromotionArtifacts('candidate-s1', tempDir)

      // Verify sidecar-free (all created sidecars cleaned)
      expect(result.sidecarFree).toBe(true)
      expect(result.mutationEvidence.added).toEqual([])
      expect(result.mutationEvidence.removed).toEqual([])

      // Verify no WAL/SHM files exist anywhere in the data root
      const dbPath = realPath.join(tempDir, 'chat.db')
      expectNoSidecarResidue(dbPath)
      expectNoSidecarResidue(snapshotPath)

      // Check the data directory for any remaining sidecar files
      const remainingFiles = realFs.readdirSync(tempDir).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))
      expect(remainingFiles).toEqual([])
    })

    it('verifies DB bytes unchanged for live DB probe', () => {
      const dbPath = makeSeededDb(tempDir)
      const beforeBytes = realFs.readFileSync(dbPath)
      probeLiveDb(tempDir)
      const afterBytes = realFs.readFileSync(dbPath)
      expect(afterBytes.equals(beforeBytes)).toBe(true)
    })

    it('verifies DB bytes unchanged for snapshot probe', () => {
      makeValidDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      realFs.renameSync(realPath.join(tempDir, 'chat.db'), snapshotPath)
      const beforeBytes = realFs.readFileSync(snapshotPath)
      probeRetainedSnapshot(tempDir)
      const afterBytes = realFs.readFileSync(snapshotPath)
      expect(afterBytes.equals(beforeBytes)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Journal observation
  // -------------------------------------------------------------------------

  describe('journal observation', () => {
    it('returns absent for non-existent journal', () => {
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('absent')
    })

    it('returns invalid for malformed JSON', () => {
      realFs.writeFileSync(realPath.join(tempDir, PROMOTION_JOURNAL_FILENAME), 'not-json')
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('invalid')
    })

    it('returns invalid for wrong version', () => {
      writeJournal(tempDir, {
        version: 999,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'snapshot-ready'
      })
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('invalid')
    })

    it('returns invalid for invalid sessionId', () => {
      writeJournal(tempDir, {
        version: 1,
        sessionId: '../evil',
        candidateId: 'candidate-s1',
        phase: 'snapshot-ready'
      })
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('invalid')
    })

    it('returns invalid for invalid candidateId', () => {
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: '../evil',
        phase: 'snapshot-ready'
      })
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('invalid')
    })

    it('returns invalid for invalid phase', () => {
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'invalid-phase'
      })
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('invalid')
    })

    it('returns valid for correct journal', () => {
      writeJournal(tempDir, {
        version: 1,
        sessionId: 's1',
        candidateId: 'candidate-s1',
        phase: 'snapshot-ready'
      })
      const result = probePromotionArtifacts(null, tempDir)
      expect(result.journal.status).toBe('valid')
      if (result.journal.status === 'valid') {
        expect(result.journal.journal.version).toBe(1)
        expect(result.journal.journal.sessionId).toBe('s1')
        expect(result.journal.journal.candidateId).toBe('candidate-s1')
        expect(result.journal.journal.phase).toBe('snapshot-ready')
      }
    })

    it('returns valid for each phase', () => {
      for (const phase of PROMOTION_JOURNAL_PHASES) {
        writeJournal(tempDir, {
          version: 1,
          sessionId: 's1',
          candidateId: 'candidate-s1',
          phase
        })
        const result = probePromotionArtifacts(null, tempDir)
        expect(result.journal.status).toBe('valid')
        realFs.unlinkSync(realPath.join(tempDir, PROMOTION_JOURNAL_FILENAME))
      }
    })
  })

  // -------------------------------------------------------------------------
  // Error detail structure
  // -------------------------------------------------------------------------

  describe('error detail structure', () => {
    it('stat-failure detail has correct shape', () => {
      realFs.mkdirSync(realPath.join(tempDir, 'chat.db'))
      const result = probeLiveDb(tempDir)
      expect(result.detail).toEqual({ kind: 'stat-failure', code: 'NOT_A_FILE' })
    })

    it('validation-failure detail has correct shape', () => {
      const dbPath = makeValidDb(tempDir)
      corruptDbToGarbage(dbPath)
      const result = probeLiveDb(tempDir)
      expect(result.detail).toEqual({
        kind: 'validation-failure',
        gate: expect.stringMatching(/^(open|integrity)$/),
        safeCode: expect.any(String)
      })
    })

    it('stat I/O error is distinguished from validation failure', () => {
      // Create a DB file, then replace it with a directory at the same path.
      // statSync succeeds (directory exists) but isFile() returns false.
      const dbPath = realPath.join(tempDir, 'chat.db')
      makeValidDb(tempDir) // creates chat.db
      realFs.rmSync(dbPath) // remove the DB file
      realFs.mkdirSync(dbPath) // put a directory in its place
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail).toEqual({ kind: 'stat-failure', code: 'NOT_A_FILE' })
    })
  })

  // -------------------------------------------------------------------------
  // Candidate ID validation edge cases
  // -------------------------------------------------------------------------

  describe('candidate ID validation (LOCK-4434)', () => {
    it('rejects empty string', () => {
      expect(probeCandidate('', tempDir)).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('rejects ID with double dots', () => {
      expect(probeCandidate('candidate-..', tempDir)).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('rejects ID with forward slash', () => {
      expect(probeCandidate('candidate-s1/sub', tempDir)).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('rejects ID with backslash', () => {
      expect(probeCandidate('candidate-s1\\sub', tempDir)).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('rejects ID without owned prefix', () => {
      expect(probeCandidate('s1', tempDir)).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('rejects ID that is just the prefix', () => {
      expect(probeCandidate('candidate-', tempDir)).toEqual({ kind: 'error', code: 'INVALID_CANDIDATE_ID' })
    })

    it('accepts valid candidate ID', () => {
      const candidateDir = makeCandidateDir(tempDir, 'candidate-s1')
      makeValidDb(candidateDir)
      expect(probeCandidate('candidate-s1', tempDir)).toEqual({ status: 'present' })
    })

    it('accepts candidate ID with underscores', () => {
      const candidateDir = makeCandidateDir(tempDir, 'candidate-import_s1')
      makeValidDb(candidateDir)
      expect(probeCandidate('candidate-import_s1', tempDir)).toEqual({ status: 'present' })
    })
  })
})
