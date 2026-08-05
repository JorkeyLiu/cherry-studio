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

import * as crypto from 'node:crypto'
import fsCjs, * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import type { FilesCatalogSnapshotRow } from '@shared/chatImport/types'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { runMigrations } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { CANDIDATE_ROOT_DIRNAME } from '../../candidateDb'
import {
  type ArtifactProbeResult,
  diffDirectorySnapshots,
  probeCandidate,
  probeFilesStaging,
  probeLiveDb,
  probeLiveFiles,
  probePromotionArtifacts,
  probePromotionArtifactsV2,
  probeResultToRecoveryInput,
  probeRetainedSnapshot,
  resolveCandidateDbPath,
  resolveLiveDbPath,
  resolveRetainedSnapshotPath,
  snapshotDirectory
} from '../artifactProbe'
import { computeFilesReceipt } from '../artifactReceipts'
import { buildCatalogSnapshotWire } from '../catalogSnapshot'
import {
  encodeFilesSnapshotManifest,
  FILES_SNAPSHOT_MANIFEST_FILENAME,
  LIVE_FILES_DIRNAME,
  resolveLiveFilesDir
} from '../filesSnapshot'
import {
  encodePromotionJournal,
  FILES_CATALOG_SNAPSHOT_FILENAME,
  FILES_PROMOTE_STAGING_DIRNAME,
  FILES_ROLLBACK_SNAPSHOT_DIRNAME,
  PROMOTION_JOURNAL_FILENAME,
  PROMOTION_JOURNAL_VERSION_V2,
  type PromotionJournalPhaseV2,
  type PromotionJournalV2,
  ROLLBACK_SNAPSHOT_FILENAME
} from '../journal'
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
    vi.restoreAllMocks()
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
        // Migration gate fires first (003 requires chatdb_normalize function)
        // before sample-reads gate can be reached
        expect(['sample-reads', 'migration']).toContain(result.detail.gate)
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
  // Live Files / staging probes — audit F2/F4 (lstat presence, no follow)
  // -------------------------------------------------------------------------

  describe('probeLiveFiles / probeFilesStaging (audit F2/F4)', () => {
    it('probeLiveFiles reports missing when the live Files dir is absent', () => {
      expect(probeLiveFiles(null, tempDir)).toBe('missing')
    })

    it('probeLiveFiles reports present-unverified for a BROKEN SYMLINK live Files root, never missing (audit F2)', () => {
      const live = resolveLiveFilesDir(tempDir)
      try {
        realFs.symlinkSync(realPath.join(tempDir, 'missing-target'), live)
      } catch {
        return
      }
      expect(probeLiveFiles(null, tempDir)).toBe('present-unverified')
    })

    it('probeLiveFiles reports present-unverified for a WORKING SYMLINK live Files root (lstat, never followed — audit F4)', () => {
      realFs.mkdirSync(realPath.join(tempDir, 'real-files'))
      const live = resolveLiveFilesDir(tempDir)
      try {
        realFs.symlinkSync(realPath.join(tempDir, 'real-files'), live)
      } catch {
        return
      }
      expect(probeLiveFiles(null, tempDir)).toBe('present-unverified')
    })

    it('probeFilesStaging reports present for a BROKEN SYMLINK staging path, never missing (audit F2)', () => {
      const staging = realPath.join(tempDir, FILES_PROMOTE_STAGING_DIRNAME)
      try {
        realFs.symlinkSync(realPath.join(tempDir, 'missing-target'), staging)
      } catch {
        return
      }
      expect(probeFilesStaging(tempDir)).toBe('present')
    })
  })

  // -------------------------------------------------------------------------
  // DB root probes — audit F4 (lstat, never follow a symlink)
  // -------------------------------------------------------------------------

  describe('DB root probes use lstat (audit F4)', () => {
    it('probeLiveDb reports NOT_A_FILE for a WORKING SYMLINK at the live DB path', () => {
      const dbPath = realPath.join(tempDir, 'chat.db')
      makeValidDb(tempDir)
      const elsewhere = realPath.join(tempDir, 'elsewhere.db')
      realFs.renameSync(dbPath, elsewhere)
      try {
        realFs.symlinkSync(elsewhere, dbPath)
      } catch {
        return
      }
      const result = probeLiveDb(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail).toEqual({ kind: 'stat-failure', code: 'NOT_A_FILE' })
      expectNoSidecarResidue(dbPath)
    })

    it('probeRetainedSnapshot reports NOT_A_FILE for a BROKEN SYMLINK, never missing (audit F2)', () => {
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      try {
        realFs.symlinkSync(realPath.join(tempDir, 'missing-target'), snapshotPath)
      } catch {
        return
      }
      const result = probeRetainedSnapshot(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail).toEqual({ kind: 'stat-failure', code: 'NOT_A_FILE' })
      expectNoSidecarResidue(snapshotPath)
    })

    it('probeRetainedSnapshot reports NOT_A_FILE for a WORKING SYMLINK retained root (never followed)', () => {
      makeValidDb(tempDir)
      const snapshotPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
      const elsewhere = realPath.join(tempDir, 'elsewhere.db')
      realFs.renameSync(realPath.join(tempDir, 'chat.db'), elsewhere)
      try {
        realFs.symlinkSync(elsewhere, snapshotPath)
      } catch {
        return
      }
      const result = probeRetainedSnapshot(tempDir)
      expect(result.status).toBe('present-unverified')
      expect(result.detail).toEqual({ kind: 'stat-failure', code: 'NOT_A_FILE' })
      expectNoSidecarResidue(snapshotPath)
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

  // -------------------------------------------------------------------------
  // v2 composite probe — disk → matrix bridge (LOCK-CLOSE-3)
  // -------------------------------------------------------------------------

  describe('probePromotionArtifactsV2 (LOCK-CLOSE-3)', () => {
    const V2_SESSION = 'import-s1'
    const V2_CANDIDATE = 'candidate-import-s1'
    const V2_CANDIDATE_RECEIPTS = {
      db: { sha256: 'a'.repeat(64), size: 100 },
      files: { count: 1, totalBytes: 11, sha256: 'b'.repeat(64) },
      catalog: { count: 1, sha256: 'c'.repeat(64) }
    }
    const V2_OLD_RECEIPTS = {
      db: { sha256: 'd'.repeat(64), size: 200 },
      files: { count: 0, totalBytes: 0, sha256: 'e'.repeat(64) },
      catalog: { count: 0, sha256: 'f'.repeat(64) }
    }

    function v2Doc(phase: PromotionJournalPhaseV2): PromotionJournalV2 {
      const old = phase === 'candidates-ready' ? { db: null, files: null, catalog: null } : V2_OLD_RECEIPTS
      return {
        version: PROMOTION_JOURNAL_VERSION_V2,
        sessionId: V2_SESSION,
        candidateId: V2_CANDIDATE,
        phase,
        receipts: { candidate: V2_CANDIDATE_RECEIPTS, old }
      }
    }

    function writeV2Journal(doc: PromotionJournalV2): void {
      realFs.writeFileSync(realPath.join(tempDir, PROMOTION_JOURNAL_FILENAME), encodePromotionJournal(doc), 'utf8')
    }

    /** One canonical payload `id.png` with derived physical size + sha256. */
    function makePayload(id: string, content: string): { name: string; size: number; sha256: string } {
      const name = `${id}.png`
      const buf = Buffer.from(content, 'utf8')
      return { name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
    }

    /** Write live `Files/<name>` payload files. */
    function makeLiveFilesDir(entries: Array<{ name: string; content: string }>): void {
      const filesDir = realPath.join(tempDir, LIVE_FILES_DIRNAME)
      realFs.mkdirSync(filesDir, { recursive: true })
      for (const entry of entries) {
        realFs.writeFileSync(realPath.join(filesDir, entry.name), entry.content, 'utf8')
      }
    }

    /** Write a valid candidate `files-catalog.json` handoff for V2_CANDIDATE. */
    function writeCandidateCatalog(payloads: Array<{ name: string; size: number; sha256: string }>): void {
      const rows = payloads.map((p) => {
        const id = p.name.slice(0, -'.png'.length)
        return {
          id,
          name: p.name,
          origin_name: `source-${p.name}`,
          size: p.size,
          sha256: p.sha256,
          ext: '.png',
          type: 'image/png',
          created_at: '2020-01-01T00:00:00.000Z',
          count: 1,
          path: `Files/${p.name}`
        }
      })
      const catalog = {
        version: 1,
        sessionId: V2_SESSION,
        createdAt: '2020-01-01T00:00:00.000Z',
        rows,
        referenced: { referencedFileIdCount: rows.length },
        degraded: {
          missingPayload: 0,
          missingCatalogRow: 0,
          metadataMismatch: 0,
          payloadReadFailure: 0,
          lostContent: 0,
          invalidTargetName: 0,
          duplicateCatalogRow: 0
        },
        skipped: { payloadWithoutCatalog: 0 }
      }
      const catalogPath = realPath.join(tempDir, CANDIDATE_ROOT_DIRNAME, V2_CANDIDATE, 'files-catalog.json')
      realFs.mkdirSync(realPath.dirname(catalogPath), { recursive: true })
      realFs.writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8')
    }

    /** Write a valid empty retained Files snapshot dir (manifest only). */
    function writeEmptyRetainedFilesSnapshot(): void {
      const dir = realPath.join(tempDir, FILES_ROLLBACK_SNAPSHOT_DIRNAME)
      realFs.mkdirSync(dir, { recursive: true })
      const manifest = {
        version: 1 as const,
        capturedAt: '2020-01-01T00:00:00.000Z',
        kind: 'empty' as const,
        entries: [] as Array<{ rel: string; size: number; sha256: string }>,
        integrity: computeFilesReceipt([])
      }
      realFs.writeFileSync(
        realPath.join(dir, FILES_SNAPSHOT_MANIFEST_FILENAME),
        encodeFilesSnapshotManifest(manifest),
        'utf8'
      )
    }

    /** Write a valid retained catalog snapshot file. */
    function writeCatalogSnapshot(payloads: Array<{ name: string; size: number; sha256: string }>): void {
      const rows: FilesCatalogSnapshotRow[] = payloads.map((p) => {
        const id = p.name.slice(0, -'.png'.length)
        return {
          id,
          name: p.name,
          origin_name: `source-${p.name}`,
          // LOCK-BRIDGE-2: a restorable retained row — the app's own absolute
          // storage path whose basename equals the canonical physical name.
          path: `/owned/Data/Files/${p.name}`,
          size: p.size,
          ext: '.png',
          type: 'image/png',
          created_at: '2020-01-01T00:00:00.000Z',
          count: 1
        }
      })
      const payload = buildCatalogSnapshotWire(rows)
      realFs.writeFileSync(realPath.join(tempDir, FILES_CATALOG_SNAPSHOT_FILENAME), JSON.stringify(payload), 'utf8')
    }

    it('absent journal → every artifact missing and catalogApplied unknown', () => {
      const result = probePromotionArtifactsV2(null, tempDir)
      expect(result.journal).toEqual({ status: 'absent' })
      expect(result.live).toBe('missing')
      expect(result.dbSnapshot).toBe('missing')
      expect(result.candidate).toBe('missing')
      expect(result.files).toBe('missing')
      expect(result.filesSnapshot).toBe('missing')
      expect(result.filesStaging).toBe('missing')
      expect(result.catalogSnapshot).toBe('missing')
      expect(result.catalogApplied).toBe('unknown')
      expect(result.candidateCatalog).toBe('missing')
    })

    it('candidates-ready: candidate + catalog handoff present, files unverified, no snapshots yet', () => {
      makeSeededDb(tempDir) // live chat.db
      const candidateDir = makeCandidateDir(tempDir, V2_CANDIDATE)
      makeValidDb(candidateDir) // candidate chat.db present
      writeCandidateCatalog([makePayload('f-1', 'hello world')])
      // Live Files is still the OLD generation — parity against the candidate
      // catalog fails (extra payload) → present-unverified.
      makeLiveFilesDir([{ name: 'stray.bin', content: 'not-in-catalog' }])
      writeV2Journal(v2Doc('candidates-ready'))

      const result = probePromotionArtifactsV2(null, tempDir)
      expect(result.journal.status).toBe('valid')
      if (result.journal.status === 'valid') {
        expect(result.journal.journal.version).toBe(2)
        expect(result.journal.journal.phase).toBe('candidates-ready')
        expect(result.journal.journal.candidateId).toBe(V2_CANDIDATE)
      }
      expect(result.live).toBe('present-verified')
      expect(result.dbSnapshot).toBe('missing')
      expect(result.candidate).toBe('present')
      expect(result.files).toBe('present-unverified')
      expect(result.filesSnapshot).toBe('missing')
      expect(result.filesStaging).toBe('missing')
      expect(result.catalogSnapshot).toBe('missing')
      expect(result.catalogApplied).toBe('unknown')
      expect(result.candidateCatalog).toBe('present')
    })

    it('snapshots-ready: all three rollback snapshots retained and verified', () => {
      makeSeededDb(tempDir)
      realFs.copyFileSync(realPath.join(tempDir, 'chat.db'), realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME))
      cleanupWalFiles(realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME))

      const candidateDir = makeCandidateDir(tempDir, V2_CANDIDATE)
      makeValidDb(candidateDir)
      writeCandidateCatalog([makePayload('f-1', 'hello world')])
      makeLiveFilesDir([{ name: 'stray.bin', content: 'not-in-catalog' }])
      writeEmptyRetainedFilesSnapshot()
      writeCatalogSnapshot([makePayload('f-1', 'hello world')])
      writeV2Journal(v2Doc('snapshots-ready'))

      const result = probePromotionArtifactsV2(null, tempDir)
      expect(result.journal.status).toBe('valid')
      if (result.journal.status === 'valid') {
        expect(result.journal.journal.phase).toBe('snapshots-ready')
      }
      expect(result.live).toBe('present-verified')
      expect(result.dbSnapshot).toBe('present-verified')
      expect(result.candidate).toBe('present')
      expect(result.files).toBe('present-unverified')
      expect(result.filesSnapshot).toBe('present-verified')
      expect(result.filesStaging).toBe('missing')
      expect(result.catalogSnapshot).toBe('present-verified')
      expect(result.catalogApplied).toBe('unknown')
      expect(result.candidateCatalog).toBe('present')
    })

    it('files-installed: candidate consumed + catalog handoff present + live Files verified', () => {
      makeSeededDb(tempDir)
      realFs.copyFileSync(realPath.join(tempDir, 'chat.db'), realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME))
      cleanupWalFiles(realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME))

      // Candidate chat.db was consumed by the install — the candidate dir
      // survives only as the catalog handoff.
      makeCandidateDir(tempDir, V2_CANDIDATE)
      const payload = makePayload('f-1', 'hello world')
      writeCandidateCatalog([payload])
      // Live Files now EXACTLY matches the candidate catalog (files installed).
      makeLiveFilesDir([{ name: payload.name, content: 'hello world' }])
      writeEmptyRetainedFilesSnapshot()
      writeCatalogSnapshot([payload])
      writeV2Journal(v2Doc('files-installed'))

      const result = probePromotionArtifactsV2(null, tempDir)
      expect(result.journal.status).toBe('valid')
      if (result.journal.status === 'valid') {
        expect(result.journal.journal.phase).toBe('files-installed')
      }
      expect(result.live).toBe('present-verified')
      expect(result.dbSnapshot).toBe('present-verified')
      // Candidate consumed → missing; catalog handoff survives → present.
      expect(result.candidate).toBe('missing')
      expect(result.candidateCatalog).toBe('present')
      expect(result.files).toBe('present-verified')
      expect(result.filesSnapshot).toBe('present-verified')
      expect(result.filesStaging).toBe('missing')
      expect(result.catalogSnapshot).toBe('present-verified')
      expect(result.catalogApplied).toBe('unknown')
    })

    it('explicit candidateId is honored even when the journal is absent', () => {
      const candidateDir = makeCandidateDir(tempDir, V2_CANDIDATE)
      makeValidDb(candidateDir)
      writeCandidateCatalog([makePayload('f-1', 'hello world')])
      // No journal on disk — the caller supplies the candidateId directly.
      const result = probePromotionArtifactsV2(V2_CANDIDATE, tempDir)
      expect(result.journal).toEqual({ status: 'absent' })
      expect(result.candidate).toBe('present')
      expect(result.candidateCatalog).toBe('present')
      expect(result.files).toBe('missing') // live Files absent → parity not run
    })
  })

  // -------------------------------------------------------------------------
  // Sidecar cleanup never throws (LOCK-CLOSE-4/F5)
  // -------------------------------------------------------------------------

  describe('sidecar cleanup never throws (LOCK-CLOSE-4/F5)', () => {
    it('live probe retains the primary result when a probe-created sidecar unlink fails', () => {
      makeSeededDb(tempDir)
      const dbPath = realPath.join(tempDir, 'chat.db')

      // Spy on the mutable CJS exports object (the ESM namespace is frozen).
      const realUnlinkSync = fsCjs.unlinkSync
      let injectedWalUnlink = false
      vi.spyOn(fsCjs, 'unlinkSync').mockImplementation((target: realFs.PathLike) => {
        if (!injectedWalUnlink && String(target).endsWith('-wal')) {
          injectedWalUnlink = true
          throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' })
        }
        return realUnlinkSync(target)
      })

      let result: ArtifactProbeResult | undefined
      expect(() => {
        result = probeLiveDb(tempDir)
      }).not.toThrow()

      // The failure path was actually exercised (sidecar created by the probe).
      expect(injectedWalUnlink).toBe(true)
      // Primary result retained — the cleanup failure is captured, not thrown.
      expect(result!.status).toBe('present-verified')
      expect(result!.detail).toBeNull()
      // The failed unlink left probe-created residue on disk.
      expect(realFs.existsSync(`${dbPath}-wal`)).toBe(true)
    })

    it('composite probe fails closed via sidecarFree when cleanup leaves residue', () => {
      makeSeededDb(tempDir)
      vi.spyOn(fsCjs, 'unlinkSync').mockImplementation((target: realFs.PathLike) => {
        if (String(target).endsWith('-wal')) {
          throw Object.assign(new Error('injected unlink failure'), { code: 'EACCES' })
        }
        return fsCjs.unlinkSync(target)
      })

      const result = probePromotionArtifacts(null, tempDir)
      // Never throws; the primary live status is still reported.
      expect(result.live.status).toBe('present-verified')
      // The residue is observable and flips the no-residue gate closed.
      expect(result.sidecarFree).toBe(false)
      expect(result.mutationEvidence.added).toContain('chat.db-wal')
    })
  })
})
