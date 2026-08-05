/**
 * Promotion preparation tests (Phase 4.4.1, LOCK-4411..4417; Phase 2 L2
 * promotion, LOCK-PREP-1..8).
 *
 * Tests the exact-once promotion preparation gate: re-entry guard → lease
 * acquisition → candidate validation + receipts → `candidates-ready` →
 * snapshot creation/validation/publish → `snapshots-ready` → prepared handle.
 *
 * Coverage:
 * - Happy path: full ordering, prepared handle carries correct fields,
 *   dispose releases lease.
 * - Durable ordering invariants: candidates-ready journaled before any
 *   snapshot work; snapshots-ready only after all three snapshots are
 *   durable; failures never overstate the journal.
 * - Cancellation at every await boundary (LOCK-PREP-4): the journal is
 *   never advanced past `candidates-ready` and the lease is released.
 * - Candidate validation (LOCK-PREP-1): catalog handoff + candidate Files
 *   ↔ catalog parity + candidate db receipt before candidates-ready.
 * - Prior journals v1/v2/invalid fail closed with no overwrite (LOCK-PREP-7).
 * - Retained replacement across a completed promotion (one-retained
 *   primitives).
 * - Empty/missing live Files and empty catalog are valid old generations
 *   with aggregate-only receipts (LOCK-PREP-6).
 * - Catalog boundary timeout / malformed snapshot / throw / NO_BOUNDARY.
 * - Tamper/readback: journaled old receipts exactly match the retained
 *   artifacts; tampered retained snapshots probe as unverified.
 * - Lease busy/release across the handle lifecycle.
 * - Handle branding/immutability/exact-once reuse (LOCK-PREP-8).
 * - Snapshot failure at every sub-step: old retained preserved, lease
 *   released, structured failure returned.
 * - Journal write failure: snapshot retained but journal not written.
 * - Dispose idempotency; exact-once consume aligned with the claim token.
 */

import * as realFs from 'node:fs'
// Default export (mutable object) — spy target for bounded fault injection;
// the production snapshot module imports the same default object.
import nodeFs from 'node:fs'
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

import {
  acquirePromotionLease,
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
  resetSharedMaintenanceCoordinatorForTests,
  validatePromotionAuthorization
} from '../../../chatDb/maintenanceCoordination'
import { runMigrations } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { computeDbReceipt } from '../artifactReceipts'
import { computeCatalogReceipt } from '../artifactReceipts'
import {
  probeRetainedCatalogSnapshot,
  readAndValidateCatalogSnapshot,
  resolveCatalogSnapshotPath
} from '../catalogSnapshot'
import {
  probeRetainedFilesSnapshot,
  readAndValidateFilesSnapshotManifest,
  resolveFilesSnapshotManifestPath,
  resolveLiveFilesDir,
  resolveRetainedFilesSnapshotDir
} from '../filesSnapshot'
import type { PromotionJournalV1, PromotionJournalV2 } from '../journal'
import { ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME } from '../journal'
import {
  getPromotionJournalPath,
  readPromotionJournal,
  writeCandidatesReadyPromotionJournal,
  writeSnapshotReadyPromotionJournal
} from '../journalStore'
import type { CatalogSnapshotBoundary, ClaimHandleLike, PromotionPreparationResult } from '../preparation'
import { preparePromotion } from '../preparation'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'cherry-promotion-prep-test-'))
}

function makeLiveDb(dir: string): { dbPath: string; sqlite: Database.Database } {
  const dbPath = realPath.join(dir, 'chat.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  sqlite.exec(`
    INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES
      ('t-1', 'a-1', 'Topic 1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}');
    INSERT INTO messages (id, topic_id, role, content, status, ask_id, model, model_id, assistant_id, created_at, updated_at, sort_order, extra) VALUES
      ('m-1', 't-1', 'user', 'hello', 'success', NULL, NULL, NULL, 'a-1', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
    INSERT INTO message_blocks (id, message_id, type, content, status, created_at, updated_at, sort_order, extra) VALUES
      ('b-1', 'm-1', 'main_text', 'hi', 'success', '2020-01-01T00:00:01.000Z', '2020-01-01T00:00:01.000Z', 0, '{}');
    INSERT INTO topic_segments (id, topic_id, name, created_at, updated_at, sort_order, extra) VALUES
      ('s-1', 't-1', 'Segment 1', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 0, '{}');
    INSERT INTO topic_segment_messages (segment_id, message_id, sort_order) VALUES ('s-1', 'm-1', 0);
  `)
  return { dbPath, sqlite }
}

function makeClaim(dir: string, overrides?: Partial<ClaimHandleLike>): ClaimHandleLike {
  const sessionId = overrides?.sessionId ?? 'import-test-session'
  const candidateId = overrides?.candidateId ?? 'candidate-import-test-session'
  const candidateDir = realPath.join(dir, 'chat-import-candidates', candidateId)
  realFs.mkdirSync(candidateDir, { recursive: true })
  const dbPath = realPath.join(candidateDir, 'chat.db')
  realFs.writeFileSync(dbPath, Buffer.from('sealed-candidate-db-bytes'))
  return {
    token: 'promotion-test-token-abc123',
    sessionId,
    candidateId,
    dbPath,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// v2 candidate artifacts + catalog boundary helpers (LOCK-PROMO-2/3)
// ---------------------------------------------------------------------------

/** Create the owned candidate dir with a valid catalog + Files dir. */
function makeCandidateArtifacts(dir: string, candidateId: string): void {
  const candidateDir = realPath.join(dir, 'chat-import-candidates', candidateId)
  realFs.mkdirSync(realPath.join(candidateDir, 'Files'), { recursive: true })
  realFs.writeFileSync(realPath.join(candidateDir, 'Files', 'f1.png'), 'hello')
  realFs.writeFileSync(
    realPath.join(candidateDir, 'files-catalog.json'),
    JSON.stringify({
      version: 1,
      sessionId: candidateId.slice('candidate-'.length),
      createdAt: new Date().toISOString(),
      rows: [
        {
          id: 'f1',
          name: 'f1.png',
          origin_name: 'f1.png',
          size: 5,
          sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
          ext: '.png',
          type: null,
          created_at: null,
          count: 1,
          path: 'Files/f1.png'
        }
      ],
      referenced: { referencedFileIdCount: 1 },
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
    }),
    'utf8'
  )
}

/** Catalog snapshot boundary double (capture succeeds). */
function makeCatalogBoundary() {
  return {
    captureSnapshot: vi.fn(async () => ({
      ok: true as const,
      snapshot: {
        version: 1 as const,
        capturedAt: new Date().toISOString(),
        rows: [],
        integrity: { count: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
      }
    }))
  }
}

/** Build one valid canonical catalog snapshot row (LOCK-BRIDGE-2 shape). */
function catalogRow(id: string, name: string, size: number, count: number): FilesCatalogSnapshotRow {
  return {
    id,
    name,
    origin_name: name,
    path: `/Data/Files/${name}`,
    size,
    ext: name.slice(id.length),
    type: null,
    created_at: null,
    count
  }
}

/** Catalog boundary double with a per-call rows provider (retained replacement). */
function makeDynamicCatalogBoundary(rowsProvider: () => FilesCatalogSnapshotRow[]) {
  return {
    captureSnapshot: vi.fn(async () => {
      const rows = rowsProvider()
      const integrity = computeCatalogReceipt(rows)
      return {
        ok: true as const,
        snapshot: { version: 1 as const, capturedAt: new Date().toISOString(), rows, integrity }
      }
    })
  }
}

/**
 * Prepare with the v2 candidate artifacts + catalog boundary wired in.
 * `createArtifacts: false` skips artifact creation so tests can inject
 * tampered/missing/empty candidate state; `catalogBoundary` and
 * `shouldAbort` override the defaults.
 */
function runPrepare(
  dir: string,
  claim: ClaimHandleLike,
  coordinator: MaintenanceCoordinator,
  getLiveSqlite: () => unknown,
  opts: {
    getLiveSqlite?: () => unknown
    createArtifacts?: boolean
    catalogBoundary?: CatalogSnapshotBoundary
    shouldAbort?: () => boolean
  } = {}
): ReturnType<typeof preparePromotion> extends Promise<infer T> ? Promise<T> : never {
  if (opts.createArtifacts !== false) makeCandidateArtifacts(dir, claim.candidateId)
  return preparePromotion(claim, dir, opts.getLiveSqlite ?? getLiveSqlite, {
    coordinator,
    catalogBoundary: opts.catalogBoundary ?? makeCatalogBoundary(),
    shouldAbort: opts.shouldAbort
  })
}

/** Write a v2 candidates-ready journal for a given identity (fixture). */
async function writeV2CandidatesReady(dir: string, sessionId: string, candidateId: string): Promise<void> {
  const doc: PromotionJournalV2 = {
    version: 2,
    sessionId,
    candidateId,
    phase: 'candidates-ready',
    receipts: {
      candidate: {
        db: { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 0 },
        files: null,
        catalog: null
      },
      old: { db: null, files: null, catalog: null }
    }
  }
  await writeCandidatesReadyPromotionJournal(doc, dir)
}

/** Read the durable journal phase (or 'absent'/'invalid'). */
async function journalPhase(dir: string): Promise<'absent' | 'invalid' | string> {
  const read = await readPromotionJournal(dir)
  if (read.status === 'absent') return 'absent'
  if (read.status === 'invalid') return 'invalid'
  return read.journal.phase
}

/** Create the live Files directory with the given payloads (name → content). */
function makeLiveFiles(dir: string, files: Record<string, string>): void {
  const liveFilesDir = resolveLiveFilesDir(dir)
  realFs.mkdirSync(liveFilesDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    realFs.writeFileSync(realPath.join(liveFilesDir, name), content, 'utf8')
  }
}

/** Write an EMPTY candidate catalog handoff (no rows; no Files dir required). */
function makeEmptyCandidateArtifacts(dir: string, candidateId: string): void {
  const candidateDir = realPath.join(dir, 'chat-import-candidates', candidateId)
  realFs.mkdirSync(candidateDir, { recursive: true })
  realFs.writeFileSync(
    realPath.join(candidateDir, 'files-catalog.json'),
    JSON.stringify({
      version: 1,
      sessionId: candidateId.slice('candidate-'.length),
      createdAt: new Date().toISOString(),
      rows: [],
      referenced: { referencedFileIdCount: 0 },
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
    }),
    'utf8'
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preparePromotion (Phase 4.4.1, LOCK-4411..4417)', () => {
  let tempDir: string
  let live: { dbPath: string; sqlite: Database.Database }
  let coordinator: MaintenanceCoordinator
  let retainedPath: string
  let journalPath: string

  beforeEach(() => {
    resetSharedMaintenanceCoordinatorForTests()
    tempDir = makeTempDir()
    live = makeLiveDb(tempDir)
    coordinator = createMaintenanceCoordinator()
    retainedPath = realPath.join(tempDir, ROLLBACK_SNAPSHOT_FILENAME)
    journalPath = getPromotionJournalPath(tempDir)
  })

  afterEach(() => {
    try {
      live.sqlite.close()
    } catch {
      /* already closed */
    }
    realFs.rmSync(tempDir, { recursive: true, force: true })
    resetSharedMaintenanceCoordinatorForTests()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('returns a prepared handle with all required fields', async () => {
      const claim = makeClaim(tempDir)
      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite)

      expect(result.ok).toBe(true)
      if (!result.ok) return

      const { handle } = result
      expect(handle.token).toBe(claim.token)
      expect(handle.sessionId).toBe(claim.sessionId)
      expect(handle.candidateId).toBe(claim.candidateId)
      expect(handle.retainedSnapshotPath).toBe(retainedPath)
      expect(handle.candidateDbPath).toBe(claim.dbPath)
      expect(handle.isDisposed()).toBe(false)
    })

    it('creates a retained rollback snapshot', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(realFs.statSync(retainedPath).isFile()).toBe(true)
      expect(realFs.existsSync(realPath.join(tempDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME))).toBe(false)

      const snapshot = new Database(retainedPath, { readonly: true, fileMustExist: true })
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
      const topics = snapshot.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
      expect(topics.c).toBe(1)
      snapshot.close()
    })

    it('writes a snapshots-ready v2 journal with both generation receipts', async () => {
      const claim = makeClaim(tempDir)
      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite)

      expect(result.ok).toBe(true)

      const journalResult = await readPromotionJournal(tempDir)
      expect(journalResult.status).toBe('valid')
      if (journalResult.status !== 'valid') return

      expect(journalResult.journal.version).toBe(2)
      expect(journalResult.journal.phase).toBe('snapshots-ready')
      expect(journalResult.journal.sessionId).toBe(claim.sessionId)
      expect(journalResult.journal.candidateId).toBe(claim.candidateId)
      if (journalResult.journal.version !== 2) return
      // Candidate + old generation aggregate receipts (LOCK-PROMO-3/12).
      expect(journalResult.journal.receipts.candidate.db?.size).toBeGreaterThan(0)
      expect(journalResult.journal.receipts.candidate.files?.count).toBe(1)
      expect(journalResult.journal.receipts.candidate.catalog?.count).toBe(1)
      expect(journalResult.journal.receipts.old.db?.size).toBeGreaterThan(0)
    })

    it('holds the promotion maintenance lease until dispose', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(true)
      if (!result.ok) return

      // Lease is held: other operations should be refused.
      const attempt = coordinator.acquire('backup', 'backup-manager')
      expect(attempt.granted).toBe(false)

      // After dispose, the slot is free.
      result.handle.dispose()
      const after = coordinator.acquire('backup', 'backup-manager')
      expect(after.granted).toBe(true)
      if (after.granted) coordinator.release(after.lease)
    })

    it('live DB stays open and usable after preparation', async () => {
      await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(live.sqlite.open).toBe(true)
      const count = live.sqlite.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
      expect(count.c).toBe(1)
    })

    it('no staging artifact remains after success', async () => {
      await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(realFs.existsSync(realPath.join(tempDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME))).toBe(false)
      expect(realFs.existsSync(`${retainedPath}-wal`)).toBe(false)
      expect(realFs.existsSync(`${retainedPath}-shm`)).toBe(false)
    })

    it('no live WAL/SHM sidecars are deleted', async () => {
      const walPath = `${live.dbPath}-wal`
      const shmPath = `${live.dbPath}-shm`
      expect(realFs.existsSync(walPath)).toBe(true)
      expect(realFs.existsSync(shmPath)).toBe(true)

      await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(realFs.existsSync(walPath)).toBe(true)
      expect(realFs.existsSync(shmPath)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Lease busy
  // -------------------------------------------------------------------------

  describe('lease busy', () => {
    it.each([
      ['backup', 'backup-manager'],
      ['restore', 'restore-owner'],
      ['init', 'live-init'],
      ['close', 'live-close']
    ] as const)('returns LEASE_BUSY when %s (owner: %s) holds the slot', async (kind, ownerId) => {
      coordinator.acquire(kind, ownerId)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.phase).toBe('acquire-lease')
      expect(result.failure.code).toBe('LEASE_BUSY')

      // Foreign holder is undisturbed.
      expect(coordinator.currentHolder()).toEqual({ kind, ownerId })
    })

    it('returns LEASE_BUSY when another promotion is in progress', async () => {
      const other = acquirePromotionLease('other-session', coordinator)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.phase).toBe('acquire-lease')
      expect(result.failure.code).toBe('LEASE_BUSY')

      other.release()
    })
  })

  // -------------------------------------------------------------------------
  // Snapshot failure — old retained preserved
  // -------------------------------------------------------------------------

  describe('snapshot failure', () => {
    it('returns SNAPSHOT_FAILED when the online backup source is closed', async () => {
      realFs.writeFileSync(retainedPath, Buffer.from('old-retained'))

      // Detach the source handle so the backup adapter fails.
      const detached = new Database(live.dbPath)
      detached.close()

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        getLiveSqlite: () => detached
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        // Accurate phase mapping (accepted 4.4.1 audit correction): a
        // failed online backup is a create-snapshot failure.
        expect(result.failure.phase).toBe('create-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('ONLINE_BACKUP_FAILED')
      }

      // Old retained preserved.
      expect(realFs.readFileSync(retainedPath).equals(Buffer.from('old-retained'))).toBe(true)
      // Lease released.
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('returns SNAPSHOT_FAILED when the live DB path does not exist', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        getLiveSqlite: () => {
          throw new Error('no db')
        }
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('create-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
      }
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('maps a staging validation failure to phase validate-snapshot', async () => {
      // A live DB missing a registered migration key produces a backup that
      // fails the migration-compatibility validation gate.
      live.sqlite.prepare(`DELETE FROM migration_state WHERE key = '002_corrective_schema'`).run()

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('validate-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('SNAPSHOT_MIGRATION_INCOMPATIBLE')
      }
      // A failed preparation never journals a destructive phase: if the
      // candidates-ready journal exists it is the safe no-mutation phase.
      if (realFs.existsSync(journalPath)) {
        const read = await readPromotionJournal(tempDir)
        expect(read.status).toBe('valid')
        if (read.status === 'valid') {
          expect(read.journal.phase).toBe('candidates-ready')
        }
      }
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('maps a publish failure to phase publish-snapshot', async () => {
      // A directory at the retained path makes the atomic rename fail.
      realFs.mkdirSync(retainedPath)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('publish-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('RETAINED_PUBLISH_FAILED')
      }
      if (realFs.existsSync(journalPath)) {
        const read = await readPromotionJournal(tempDir)
        if (read.status === 'valid') {
          expect(read.journal.phase).toBe('candidates-ready')
        }
      }
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('post-rename directory-sync failure cannot journal: preparation fails, lease released (LOCK-4412/4417)', async () => {
      // Bounded injection: fail ONLY the parent-directory fsync open that
      // runs after the atomic rename (fsyncDirectory opens dbDir itself).
      const realOpenSync = nodeFs.openSync
      const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
        filePath: realFs.PathLike,
        flags: realFs.OpenMode,
        mode?: realFs.Mode | null
      ) => {
        if (filePath === tempDir) {
          const error: NodeJS.ErrnoException = new Error('EIO: injected directory fsync failure')
          error.code = 'EIO'
          throw error
        }
        return realOpenSync(filePath, flags, mode)
      }) as typeof realFs.openSync)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      openSpy.mockRestore()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('publish-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('RETAINED_DIRECTORY_SYNC_FAILED')
      }
      // The unconfirmed-durability snapshot can NEVER be journaled as
      // snapshots-ready: a crash could surface a journal pointing at a
      // rename that was never durable. At most the safe candidates-ready
      // phase may exist.
      if (realFs.existsSync(journalPath)) {
        const read = await readPromotionJournal(tempDir)
        if (read.status === 'valid') {
          expect(read.journal.phase).toBe('candidates-ready')
        }
      }
      // Lease released for the next operation.
      expect(coordinator.currentHolder()).toBeNull()
      // Live DB untouched and open (LOCK-4411).
      expect(live.sqlite.open).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Dispose idempotency
  // -------------------------------------------------------------------------

  describe('dispose', () => {
    it('dispose is idempotent', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      result.handle.dispose()
      expect(result.handle.isDisposed()).toBe(true)

      // Second dispose is a safe no-op.
      result.handle.dispose()
      expect(result.handle.isDisposed()).toBe(true)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('dispose releases the lease for the next operation', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      result.handle.dispose()
      expect(coordinator.currentHolder()).toBeNull()

      // Another promotion can now proceed.
      const next = coordinator.acquire('promotion', 'next-session')
      expect(next.granted).toBe(true)
      if (next.granted) coordinator.release(next.lease)
    })
  })

  // -------------------------------------------------------------------------
  // Exact-once consume / executing capability transfer (Phase 4.4.2,
  // LOCK-4421/LOCK-4422)
  // -------------------------------------------------------------------------

  describe('exact-once consume (LOCK-4421/4422)', () => {
    it('consume transfers the SAME lease to an executing capability carrying all fields', async () => {
      const claim = makeClaim(tempDir)
      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const consumeResult = result.handle.consume()
      expect(consumeResult.ok).toBe(true)
      if (!consumeResult.ok) return

      const { capability } = consumeResult
      expect(capability.token).toBe(claim.token)
      expect(capability.sessionId).toBe(claim.sessionId)
      expect(capability.candidateId).toBe(claim.candidateId)
      expect(capability.retainedSnapshotPath).toBe(retainedPath)
      expect(capability.candidateDbPath).toBe(claim.dbPath)
      expect(capability.isReleased()).toBe(false)
      expect(result.handle.isConsumed()).toBe(true)

      // The SAME promotion lease is still continuously held (no
      // release/reacquire): the slot never moved.
      expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: claim.candidateId })
      // The capability's authorization proves the currently held lease.
      expect(validatePromotionAuthorization(capability.authorization, coordinator)).toEqual({
        authorized: true,
        ownerId: claim.candidateId
      })

      capability.release()
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('consume is exact-once: a second consume is refused with already-consumed', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const first = result.handle.consume()
      expect(first.ok).toBe(true)

      const second = result.handle.consume()
      expect(second).toEqual({ ok: false, reason: 'already-consumed' })
      // The transferred lease is untouched by the refused attempt.
      expect(coordinator.currentHolder()).not.toBeNull()

      if (first.ok) first.capability.release()
    })

    it('a disposed handle can never yield the destructive capability', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      result.handle.dispose()
      expect(coordinator.currentHolder()).toBeNull()

      const consumeResult = result.handle.consume()
      expect(consumeResult).toEqual({ ok: false, reason: 'disposed' })
    })

    it('stale disposer after consume does NOT release the transferred lease', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const consumeResult = result.handle.consume()
      expect(consumeResult.ok).toBe(true)
      if (!consumeResult.ok) return

      // The old prepared-handle disposer is now stale: dispose must be a
      // lease-preserving no-op (the executing capability owns the release).
      result.handle.dispose()
      expect(result.handle.isDisposed()).toBe(true)
      expect(coordinator.currentHolder()).not.toBeNull()
      expect(consumeResult.capability.isReleased()).toBe(false)
      expect(validatePromotionAuthorization(consumeResult.capability.authorization, coordinator).authorized).toBe(true)

      // Only the capability releases — exactly once, idempotently.
      consumeResult.capability.release()
      expect(consumeResult.capability.isReleased()).toBe(true)
      expect(coordinator.currentHolder()).toBeNull()
      consumeResult.capability.release()
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('released capability authorization is stale and can no longer act', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const consumeResult = result.handle.consume()
      expect(consumeResult.ok).toBe(true)
      if (!consumeResult.ok) return

      consumeResult.capability.release()
      expect(validatePromotionAuthorization(consumeResult.capability.authorization, coordinator)).toEqual({
        authorized: false,
        reason: 'released'
      })

      // The freed slot is available to the next maintenance operation; the
      // stale authorization cannot disturb the new holder.
      const next = coordinator.acquire('backup', 'backup-manager')
      expect(next.granted).toBe(true)
      expect(validatePromotionAuthorization(consumeResult.capability.authorization, coordinator).authorized).toBe(false)
      if (next.granted) coordinator.release(next.lease)
    })
  })

  // -------------------------------------------------------------------------
  // Token alignment
  // -------------------------------------------------------------------------

  describe('token alignment', () => {
    it('prepared handle carries the exact claim token', async () => {
      const token = 'exact-token-' + Date.now().toString(36)
      const claim = makeClaim(tempDir, { token })
      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.handle.token).toBe(token)
      result.handle.dispose()
    })

    it('different claims produce different handles with different tokens', async () => {
      const claimA = makeClaim(tempDir, {
        token: 'token-a',
        sessionId: 'session-a',
        candidateId: 'candidate-session-a'
      })
      // Independent data roots keep the two claims isolated (the one-retained
      // primitives DO support same-dir replacement — covered separately by
      // the retained-replacement suite).
      const secondDir = makeTempDir()
      const claimB = makeClaim(secondDir, {
        token: 'token-b',
        sessionId: 'session-b',
        candidateId: 'candidate-session-b'
      })

      const resultA = await runPrepare(tempDir, claimA, coordinator, () => live.sqlite)
      expect(resultA.ok).toBe(true)
      if (resultA.ok) resultA.handle.dispose()

      const resultB = await runPrepare(secondDir, claimB, coordinator, () => live.sqlite)
      expect(resultB.ok).toBe(true)
      if (resultB.ok) resultB.handle.dispose()
      realFs.rmSync(secondDir, { recursive: true, force: true })

      expect(resultA.ok && resultB.ok && resultA.handle.token !== resultB.handle.token).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // No journal written by snapshot unit (LOCK-4417 boundary)
  // -------------------------------------------------------------------------

  describe('LOCK-4417 boundary', () => {
    it('the snapshot unit never writes a journal file', async () => {
      // Before preparation, no journal exists.
      expect(realFs.existsSync(journalPath)).toBe(false)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (result.ok) result.handle.dispose()

      // The preparation function wrote the journal, not the snapshot unit.
      expect(realFs.existsSync(journalPath)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Durable ordering invariants (LOCK-PREP-3 — the journal never overstates)
  // -------------------------------------------------------------------------

  describe('durable ordering invariants (LOCK-PREP-3)', () => {
    it('candidates-ready is journaled BEFORE any snapshot work', async () => {
      const boundary = makeCatalogBoundary()
      const detached = new Database(live.dbPath)
      detached.close()

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        getLiveSqlite: () => detached,
        catalogBoundary: boundary
      })

      expect(result.ok).toBe(false)
      // The safe no-mutation phase is durable on disk.
      expect(await journalPhase(tempDir)).toBe('candidates-ready')
      // The db snapshot never ran, so the catalog boundary was never reached
      // and no retained db snapshot exists.
      expect(boundary.captureSnapshot.mock.calls.length).toBe(0)
      expect(realFs.existsSync(retainedPath)).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()
      expect(live.sqlite.open).toBe(true)
    })

    it('a files-snapshot failure leaves candidates-ready and never reaches the catalog boundary', async () => {
      const boundary = makeCatalogBoundary()
      // Non-canonical live filename → SOURCE_STAT_FAILED (NON_CANONICAL_FILENAME).
      makeLiveFiles(tempDir, { 'bad name!.png': 'x' })

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: boundary
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('FILES_SNAPSHOT_FAILED')
        expect(result.failure.phase).toBe('create-files-snapshot')
        expect(result.failure.safeCode).toBe('SOURCE_STAT_FAILED')
      }
      expect(await journalPhase(tempDir)).toBe('candidates-ready')
      // Ordering: the db snapshot completed BEFORE the files step failed, and
      // the catalog boundary comes strictly after Files — it must never fire.
      expect(realFs.existsSync(retainedPath)).toBe(true)
      expect(boundary.captureSnapshot.mock.calls.length).toBe(0)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('snapshots-ready is journaled only after all three snapshots are retained and verified', async () => {
      const boundary = makeDynamicCatalogBoundary(() => [catalogRow('f1', 'f1.png', 5, 1)])
      makeLiveFiles(tempDir, { 'f1.png': 'hello' })

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: boundary
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return

      // Every retained artifact is confirmed BEFORE the snapshots-ready phase.
      expect(realFs.statSync(retainedPath).isFile()).toBe(true)
      const filesManifest = readAndValidateFilesSnapshotManifest(
        resolveFilesSnapshotManifestPath(resolveRetainedFilesSnapshotDir(tempDir))
      )
      expect(filesManifest).not.toBeNull()
      if (filesManifest !== null) {
        expect(filesManifest.kind).toBe('populated')
        expect(filesManifest.entries.length).toBe(1)
      }
      expect(readAndValidateCatalogSnapshot(tempDir)).not.toBeNull()
      expect(await journalPhase(tempDir)).toBe('snapshots-ready')

      result.handle.dispose()
    })

    it('a failed last durable step (catalog publish) never journals snapshots-ready', async () => {
      // Malformed snapshot from the boundary → the durable writer rejects it
      // pre-publish; the db+files snapshots are retained but the journal must
      // stay at candidates-ready (no overstatement).
      const malformedBoundary: CatalogSnapshotBoundary = {
        captureSnapshot: vi.fn(async () => ({
          ok: true as const,
          snapshot: {
            version: 1 as const,
            capturedAt: new Date().toISOString(),
            rows: [],
            integrity: { count: 0, sha256: '0'.repeat(64) }
          }
        }))
      }

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: malformedBoundary
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('CATALOG_SNAPSHOT_FAILED')
        expect(result.failure.phase).toBe('capture-catalog-snapshot')
        expect(result.failure.safeCode).toBe('PAYLOAD_INVALID')
      }
      expect(await journalPhase(tempDir)).toBe('candidates-ready')
      expect(realFs.existsSync(retainedPath)).toBe(true)
      expect(realFs.existsSync(resolveRetainedFilesSnapshotDir(tempDir))).toBe(true)
      // No catalog snapshot was published.
      expect(realFs.existsSync(resolveCatalogSnapshotPath(tempDir))).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Cancellation at every await boundary (LOCK-PREP-4)
  // -------------------------------------------------------------------------

  describe('cancellation at await boundaries (LOCK-PREP-4)', () => {
    it.each([
      // [abortAfterBoundaries, expectedPhase, journal, retainedDb, retainedFiles, catalogBoundaryCalls, catalogSnapshot]
      [0, 'candidates-ready-journal', 'absent', false, false, 0, false],
      [1, 'candidates-ready-journal', 'absent', false, false, 0, false],
      [2, 'create-snapshot', 'candidates-ready', false, false, 0, false],
      [3, 'create-files-snapshot', 'candidates-ready', true, false, 0, false],
      [4, 'capture-catalog-snapshot', 'candidates-ready', true, true, 0, false],
      [5, 'journal-snapshots-ready', 'candidates-ready', true, true, 1, true]
    ] as const)(
      'cancel after %i boundaries → CANCELLED at %s; journal %s; no overstate',
      async (
        abortAfter,
        expectedPhase,
        expectedJournal,
        expectDbRetained,
        expectFilesRetained,
        boundaryCalls,
        expectCatalogRetained
      ) => {
        let checks = 0
        const boundary = makeCatalogBoundary()
        makeLiveFiles(tempDir, { 'f1.png': 'hello' })

        const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
          catalogBoundary: boundary,
          shouldAbort: () => ++checks > abortAfter
        })

        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.failure.code).toBe('CANCELLED')
          expect(result.failure.phase).toBe(expectedPhase)
        }
        // The journal never overstates: at most the safe candidates-ready phase.
        expect(await journalPhase(tempDir)).toBe(expectedJournal)
        expect(realFs.existsSync(retainedPath)).toBe(expectDbRetained)
        expect(realFs.existsSync(resolveRetainedFilesSnapshotDir(tempDir))).toBe(expectFilesRetained)
        expect(boundary.captureSnapshot.mock.calls.length).toBe(boundaryCalls)
        expect(realFs.existsSync(resolveCatalogSnapshotPath(tempDir))).toBe(expectCatalogRetained)
        // Lease released for the next operation; live DB untouched and open.
        expect(coordinator.currentHolder()).toBeNull()
        expect(live.sqlite.open).toBe(true)
        // No staging residue from the interrupted run.
        expect(realFs.existsSync(realPath.join(tempDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME))).toBe(false)
      }
    )
  })

  // -------------------------------------------------------------------------
  // Candidate artifact validation (LOCK-PREP-1)
  // -------------------------------------------------------------------------

  describe('candidate artifact validation (LOCK-PREP-1)', () => {
    it('rejects a missing candidate payload (parity PAYLOAD_MISSING)', async () => {
      const claim = makeClaim(tempDir)
      makeCandidateArtifacts(tempDir, claim.candidateId)
      realFs.rmSync(realPath.join(tempDir, 'chat-import-candidates', claim.candidateId, 'Files', 'f1.png'))

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('candidates-ready-journal')
        expect(result.failure.code).toBe('CANDIDATE_INVALID')
        expect(result.failure.safeCode).toBe('CANDIDATE_PAYLOAD_MISSING')
      }
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('rejects a tampered candidate payload (parity PAYLOAD_HASH_MISMATCH)', async () => {
      const claim = makeClaim(tempDir)
      makeCandidateArtifacts(tempDir, claim.candidateId)
      realFs.writeFileSync(
        realPath.join(tempDir, 'chat-import-candidates', claim.candidateId, 'Files', 'f1.png'),
        'xxllo'
      )

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('CANDIDATE_INVALID')
        expect(result.failure.safeCode).toBe('CANDIDATE_PAYLOAD_HASH_MISMATCH')
      }
      expect(realFs.existsSync(journalPath)).toBe(false)
    })

    it('rejects an extra candidate payload (parity EXTRA_PAYLOAD)', async () => {
      const claim = makeClaim(tempDir)
      makeCandidateArtifacts(tempDir, claim.candidateId)
      realFs.writeFileSync(
        realPath.join(tempDir, 'chat-import-candidates', claim.candidateId, 'Files', 'extra.png'),
        'x'
      )

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('CANDIDATE_INVALID')
        expect(result.failure.safeCode).toBe('CANDIDATE_EXTRA_PAYLOAD')
      }
    })

    it('rejects a missing candidate Files dir with a non-empty catalog', async () => {
      const claim = makeClaim(tempDir)
      makeCandidateArtifacts(tempDir, claim.candidateId)
      realFs.rmSync(realPath.join(tempDir, 'chat-import-candidates', claim.candidateId, 'Files'), {
        recursive: true,
        force: true
      })

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('CANDIDATE_INVALID')
        expect(result.failure.safeCode).toBe('CANDIDATE_FILES_DIR_MISSING')
      }
      expect(realFs.existsSync(journalPath)).toBe(false)
    })

    it('rejects a corrupt catalog handoff (CATALOG_UNREADABLE)', async () => {
      const claim = makeClaim(tempDir)
      makeCandidateArtifacts(tempDir, claim.candidateId)
      realFs.writeFileSync(
        realPath.join(tempDir, 'chat-import-candidates', claim.candidateId, 'files-catalog.json'),
        '{not json',
        'utf8'
      )

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('CANDIDATE_INVALID')
        expect(result.failure.safeCode).toBe('CATALOG_UNREADABLE')
      }
      expect(realFs.existsSync(journalPath)).toBe(false)
    })

    it('rejects a path-unsafe candidateId fail-closed at the lease seam (bounded, no mutation)', async () => {
      const claim = makeClaim(tempDir, { candidateId: 'candidate-../../escape' })

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      // The candidateId is validated by the claim in production; an unsafe ID
      // that reaches the lease seam is refused with the bounded busy code
      // before any artifact work — never the generic catch-all.
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('acquire-lease')
        expect(result.failure.code).toBe('LEASE_BUSY')
      }
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Catalog boundary failures (timeout / malformed / throw / NO_BOUNDARY)
  // -------------------------------------------------------------------------

  describe('catalog boundary failures', () => {
    it('maps a boundary timeout to CATALOG_SNAPSHOT_FAILED at capture-catalog-snapshot', async () => {
      const timeoutBoundary: CatalogSnapshotBoundary = {
        captureSnapshot: vi.fn(async () => ({ ok: false as const, code: 'TIMEOUT' }))
      }

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: timeoutBoundary
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('capture-catalog-snapshot')
        expect(result.failure.code).toBe('CATALOG_SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('TIMEOUT')
      }
      expect(await journalPhase(tempDir)).toBe('candidates-ready')
      expect(realFs.existsSync(resolveCatalogSnapshotPath(tempDir))).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('maps a boundary NO_TARGET failure to CATALOG_SNAPSHOT_FAILED', async () => {
      const noTargetBoundary: CatalogSnapshotBoundary = {
        captureSnapshot: vi.fn(async () => ({ ok: false as const, code: 'NO_TARGET' }))
      }

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: noTargetBoundary
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('capture-catalog-snapshot')
        expect(result.failure.code).toBe('CATALOG_SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('NO_TARGET')
      }
    })

    it('maps a throwing boundary to CATALOG_SNAPSHOT_FAILED with the safe error code', async () => {
      const throwingBoundary: CatalogSnapshotBoundary = {
        captureSnapshot: vi.fn(async () => {
          const error: NodeJS.ErrnoException = new Error('injected')
          error.code = 'EINVAL'
          throw error
        })
      }

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: throwingBoundary
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('capture-catalog-snapshot')
        expect(result.failure.code).toBe('CATALOG_SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('EINVAL')
      }
      expect(await journalPhase(tempDir)).toBe('candidates-ready')
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('fails closed with NO_BOUNDARY when no catalog boundary is wired', async () => {
      const claim = makeClaim(tempDir)
      makeCandidateArtifacts(tempDir, claim.candidateId)
      // Options object WITHOUT a catalogBoundary key value → NO_BOUNDARY.
      const result = await preparePromotion(claim, tempDir, () => live.sqlite, {
        coordinator,
        catalogBoundary: undefined
      })

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('capture-catalog-snapshot')
        expect(result.failure.code).toBe('CATALOG_SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('NO_BOUNDARY')
      }
      expect(await journalPhase(tempDir)).toBe('candidates-ready')
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('a malformed snapshot does not clobber a previously retained catalog snapshot', async () => {
      // First run succeeds and retains a valid catalog snapshot.
      const rowsBoundary = makeDynamicCatalogBoundary(() => [catalogRow('f1', 'f1.png', 5, 1)])
      const first = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: rowsBoundary
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      first.handle.dispose()
      const retainedBytes = realFs.readFileSync(resolveCatalogSnapshotPath(tempDir))

      // Completed-promotion cleanup removes the journal only.
      realFs.rmSync(journalPath, { force: true })

      // Second run: boundary returns a malformed snapshot → publish rejected,
      // and the PREVIOUS retained catalog snapshot is byte-for-byte intact.
      const malformedBoundary: CatalogSnapshotBoundary = {
        captureSnapshot: vi.fn(async () => ({
          ok: true as const,
          snapshot: {
            version: 1 as const,
            capturedAt: new Date().toISOString(),
            rows: [catalogRow('f1', 'f1.png', 5, 1)],
            integrity: { count: 1, sha256: '0'.repeat(64) }
          }
        }))
      }
      const second = await runPrepare(
        tempDir,
        makeClaim(tempDir, { sessionId: 'session-b', candidateId: 'candidate-session-b' }),
        coordinator,
        () => live.sqlite,
        { catalogBoundary: malformedBoundary }
      )

      expect(second.ok).toBe(false)
      if (!second.ok) {
        expect(resultFailureCode(second)).toBe('CATALOG_SNAPSHOT_FAILED')
        expect(resultFailureSafeCode(second)).toBe('PAYLOAD_INVALID')
      }
      expect(realFs.readFileSync(resolveCatalogSnapshotPath(tempDir)).equals(retainedBytes)).toBe(true)
      expect(coordinator.currentHolder()).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Empty / missing generations are valid old state (LOCK-PREP-6)
  // -------------------------------------------------------------------------

  describe('empty generations (LOCK-PREP-6)', () => {
    it('missing live Files + empty catalog journal zero-count aggregate old receipts', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const read = await readPromotionJournal(tempDir)
      expect(read.status).toBe('valid')
      if (read.status !== 'valid' || read.journal.version !== 2) return

      // Empty old Files generation: count 0 + canonical empty digest.
      expect(read.journal.receipts.old.files).toEqual({
        count: 0,
        totalBytes: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      })
      // Empty old catalog generation: count 0 + canonical empty digest.
      expect(read.journal.receipts.old.catalog).toEqual({
        count: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      })
      // The retained Files snapshot records kind 'empty' with zero entries.
      const manifest = readAndValidateFilesSnapshotManifest(
        resolveFilesSnapshotManifestPath(resolveRetainedFilesSnapshotDir(tempDir))
      )
      expect(manifest?.kind).toBe('empty')
      expect(manifest?.entries.length).toBe(0)
      result.handle.dispose()
    })

    it('an empty candidate catalog + missing candidate Files dir is a valid empty candidate generation', async () => {
      const claim = makeClaim(tempDir)
      // Empty catalog; no Files dir at all.
      makeEmptyCandidateArtifacts(tempDir, claim.candidateId)

      const result = await runPrepare(tempDir, claim, coordinator, () => live.sqlite, { createArtifacts: false })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      const read = await readPromotionJournal(tempDir)
      expect(read.status).toBe('valid')
      if (read.status === 'valid' && read.journal.version === 2) {
        expect(read.journal.receipts.candidate.files?.count).toBe(0)
        expect(read.journal.receipts.candidate.catalog?.count).toBe(0)
      }
      result.handle.dispose()
    })
  })

  // -------------------------------------------------------------------------
  // Re-entry with an existing journal fails closed (LOCK-PREP-7)
  // -------------------------------------------------------------------------

  describe('prior journals fail closed (LOCK-PREP-7)', () => {
    it('an existing v1 journal fails closed with V1_JOURNAL and is preserved byte-for-byte', async () => {
      const v1: PromotionJournalV1 = {
        version: 1,
        sessionId: 'legacy-session',
        candidateId: 'candidate-legacy-session',
        phase: 'snapshot-ready'
      }
      await writeSnapshotReadyPromotionJournal(v1, tempDir)
      const before = realFs.readFileSync(journalPath)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('candidates-ready-journal')
        expect(result.failure.code).toBe('JOURNAL_EXISTS')
        expect(result.failure.safeCode).toBe('V1_JOURNAL')
      }
      // The v1 journal is untouched (no overwrite of another protocol).
      expect(realFs.readFileSync(journalPath).equals(before)).toBe(true)
      const read = await readPromotionJournal(tempDir)
      expect(read.status).toBe('valid')
      if (read.status === 'valid') expect(read.journal.version).toBe(1)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it.each([
      ['another session v2 candidates-ready', 'other-session', 'candidate-other-session'],
      ['same-session v2 snapshots-ready', 'import-test-session', 'candidate-import-test-session']
    ])(
      'an existing v2 journal (%s) fails closed with V2_JOURNAL and is preserved',
      async (_label, sessionId, candidateId) => {
        await writeV2CandidatesReady(tempDir, sessionId, candidateId)
        const before = realFs.readFileSync(journalPath)

        const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.failure.phase).toBe('candidates-ready-journal')
          expect(result.failure.code).toBe('JOURNAL_EXISTS')
          expect(result.failure.safeCode).toBe('V2_JOURNAL')
        }
        expect(realFs.readFileSync(journalPath).equals(before)).toBe(true)
        expect(coordinator.currentHolder()).toBeNull()
      }
    )

    it('a codec-invalid journal fails closed with INVALID_JOURNAL and is preserved (evidence not clobbered)', async () => {
      realFs.writeFileSync(journalPath, '{"version":2,"corrupt":true', 'utf8')
      const before = realFs.readFileSync(journalPath)

      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('JOURNAL_EXISTS')
        expect(result.failure.safeCode).toBe('INVALID_JOURNAL')
      }
      expect(realFs.readFileSync(journalPath).equals(before)).toBe(true)
      expect(coordinator.currentHolder()).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Retained replacement across completed promotions (one-retained primitives)
  // -------------------------------------------------------------------------

  describe('retained replacement (one-retained primitives)', () => {
    it('a second promotion replaces the retained db/Files/catalog snapshots through the hardened primitives', async () => {
      let rows: FilesCatalogSnapshotRow[] = [catalogRow('f1', 'f1.png', 5, 1)]
      const boundary = makeDynamicCatalogBoundary(() => rows)
      makeLiveFiles(tempDir, { 'f1.png': 'hello' })

      const first = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: boundary
      })
      expect(first.ok).toBe(true)
      if (!first.ok) return
      first.handle.dispose()
      const firstDbSnapshotHash = (await computeDbReceipt(retainedPath)).sha256
      const firstCatalogSnapshotBytes = realFs.readFileSync(resolveCatalogSnapshotPath(tempDir))

      // Simulate completed-promotion cleanup: the journal is removed, the
      // retained snapshots stay (the one-retained primitives replace them).
      realFs.rmSync(journalPath, { force: true })

      // Live state advances before the next promotion.
      live.sqlite
        .prepare(
          `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra) VALUES (?, ?, ?, ?, ?, NULL, '{}')`
        )
        .run('t-2', 'a-1', 'Topic 2', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z')
      makeLiveFiles(tempDir, { 'f1.png': 'hello', 'f2.png': 'world' })
      rows = [catalogRow('f1', 'f1.png', 5, 1), catalogRow('f2', 'f2.png', 5, 1)]

      const secondClaim = makeClaim(tempDir, { sessionId: 'session-b', candidateId: 'candidate-session-b' })
      const second = await runPrepare(tempDir, secondClaim, coordinator, () => live.sqlite, {
        catalogBoundary: boundary
      })

      expect(second.ok).toBe(true)
      if (!second.ok) return
      try {
        // db retained snapshot was atomically replaced with the NEW live state.
        const secondDbSnapshotHash = (await computeDbReceipt(retainedPath)).sha256
        expect(secondDbSnapshotHash).not.toBe(firstDbSnapshotHash)
        const snapshot = new Database(retainedPath, { readonly: true, fileMustExist: true })
        try {
          const topics = snapshot.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
          expect(topics.c).toBe(2)
        } finally {
          snapshot.close()
        }
        // Files retained snapshot replaced (manifest now has two entries).
        const manifest = readAndValidateFilesSnapshotManifest(
          resolveFilesSnapshotManifestPath(resolveRetainedFilesSnapshotDir(tempDir))
        )
        expect(manifest?.kind).toBe('populated')
        expect(manifest?.entries.length).toBe(2)
        expect(probeRetainedFilesSnapshot(tempDir)).toEqual({ status: 'present-verified' })
        // Catalog retained snapshot replaced (bytes differ, still verifiable).
        expect(realFs.readFileSync(resolveCatalogSnapshotPath(tempDir)).equals(firstCatalogSnapshotBytes)).toBe(false)
        expect(probeRetainedCatalogSnapshot(tempDir)).toEqual({ status: 'present-verified' })
        // The second journal is the new session's snapshots-ready.
        expect(await journalPhase(tempDir)).toBe('snapshots-ready')
        const read = await readPromotionJournal(tempDir)
        if (read.status === 'valid' && read.journal.version === 2) {
          expect(read.journal.sessionId).toBe('session-b')
          expect(read.journal.candidateId).toBe('candidate-session-b')
        }
      } finally {
        second.handle.dispose()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Old receipts are exact (tamper/readback evidence, LOCK-PREP-2)
  // -------------------------------------------------------------------------

  describe('old receipts exact + tamper detection (LOCK-PREP-2)', () => {
    it('journaled old receipts equal the independently recomputed retained artifacts', async () => {
      makeLiveFiles(tempDir, { 'f1.png': 'hello' })
      const boundary = makeDynamicCatalogBoundary(() => [catalogRow('f1', 'f1.png', 5, 1)])
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: boundary
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const read = await readPromotionJournal(tempDir)
      expect(read.status).toBe('valid')
      if (read.status !== 'valid' || read.journal.version !== 2) {
        result.handle.dispose()
        return
      }
      try {
        const old = read.journal.receipts.old
        // db: exact hash of the retained snapshot file.
        expect(old.db).toEqual(await computeDbReceipt(retainedPath))
        // files: exact manifest integrity of the retained Files snapshot.
        const manifest = readAndValidateFilesSnapshotManifest(
          resolveFilesSnapshotManifestPath(resolveRetainedFilesSnapshotDir(tempDir))
        )
        expect(manifest?.integrity).toEqual(old.files)
        // catalog: exact integrity of the retained catalog snapshot.
        const catalogSnapshot = readAndValidateCatalogSnapshot(tempDir)
        expect(catalogSnapshot?.integrity).toEqual(old.catalog)
        // candidate receipts are immutable and branded on the capability.
        const consume = result.handle.consume()
        if (consume.ok) {
          expect(consume.capability.receipts.old).toEqual(old)
          consume.capability.release()
        }
      } finally {
        result.handle.dispose()
      }
    })

    it('tampering the retained catalog snapshot makes it probe as present-unverified', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      result.handle.dispose()

      const snapshotPath = resolveCatalogSnapshotPath(tempDir)
      realFs.appendFileSync(snapshotPath, Buffer.from('tamper'))
      expect(probeRetainedCatalogSnapshot(tempDir).status).toBe('present-unverified')
    })

    it('tampering the retained Files manifest makes it probe as present-unverified', async () => {
      makeLiveFiles(tempDir, { 'f1.png': 'hello' })
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      result.handle.dispose()

      realFs.appendFileSync(
        resolveFilesSnapshotManifestPath(resolveRetainedFilesSnapshotDir(tempDir)),
        Buffer.from('tamper')
      )
      expect(probeRetainedFilesSnapshot(tempDir).status).toBe('present-unverified')
    })
  })

  // -------------------------------------------------------------------------
  // Lease lifecycle across handles (LOCK-4416 / LOCK-PREP-4/5)
  // -------------------------------------------------------------------------

  describe('lease lifecycle', () => {
    it('an undisposed handle holds the shared lease; dispose frees it for the next promotion', async () => {
      const first = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(first.ok).toBe(true)
      if (!first.ok) return

      // A second promotion on ANOTHER data root sharing the SAME coordinator
      // is refused while the first handle is undisposed (LEASE_BUSY) — the
      // maintenance slot is process-global across backup/restore/promotion.
      const secondDir = makeTempDir()
      try {
        const second = await runPrepare(
          secondDir,
          makeClaim(secondDir, { sessionId: 'session-b', candidateId: 'candidate-session-b' }),
          coordinator,
          () => live.sqlite
        )
        expect(second.ok).toBe(false)
        if (!second.ok) {
          expect(second.failure.phase).toBe('acquire-lease')
          expect(second.failure.code).toBe('LEASE_BUSY')
        }

        first.handle.dispose()
        expect(coordinator.currentHolder()).toBeNull()

        const third = await runPrepare(
          secondDir,
          makeClaim(secondDir, { sessionId: 'session-b', candidateId: 'candidate-session-b' }),
          coordinator,
          () => live.sqlite
        )
        expect(third.ok).toBe(true)
        if (third.ok) third.handle.dispose()
      } finally {
        realFs.rmSync(secondDir, { recursive: true, force: true })
      }
    })

    it('failure at the catalog boundary releases the lease for the next operation', async () => {
      const timeoutBoundary: CatalogSnapshotBoundary = {
        captureSnapshot: vi.fn(async () => ({ ok: false as const, code: 'TIMEOUT' }))
      }
      const failed = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite, {
        catalogBoundary: timeoutBoundary
      })
      expect(failed.ok).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()

      const after = coordinator.acquire('backup', 'backup-manager')
      expect(after.granted).toBe(true)
      if (after.granted) coordinator.release(after.lease)
    })
  })

  // -------------------------------------------------------------------------
  // Handle branding / immutability / exact-once reuse (LOCK-PREP-8)
  // -------------------------------------------------------------------------

  describe('handle branding and immutability (LOCK-PREP-8)', () => {
    it('the handle and its receipts are frozen (tamper-evident branding)', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        expect(Object.isFrozen(result.handle)).toBe(true)
        const consume = result.handle.consume()
        expect(consume.ok).toBe(true)
        if (!consume.ok) return
        expect(Object.isFrozen(consume.capability)).toBe(true)
        expect(Object.isFrozen(consume.capability.receipts)).toBe(true)
        expect(Object.isFrozen(consume.capability.receipts.candidate)).toBe(true)
        // Assigning into the branded receipts is a strict-mode TypeError.
        expect(() => {
          ;(consume.capability.receipts as { candidate?: unknown }).candidate = null
        }).toThrow(TypeError)
        expect(() => {
          ;(consume.capability.receipts.candidate as { db?: unknown }).db = null
        }).toThrow(TypeError)
        consume.capability.release()
      } finally {
        result.handle.dispose()
      }
    })

    it('a released capability leaves the handle permanently one-shot', async () => {
      const result = await runPrepare(tempDir, makeClaim(tempDir), coordinator, () => live.sqlite)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const consume = result.handle.consume()
        expect(consume.ok).toBe(true)
        if (!consume.ok) return
        consume.capability.release()

        // Even after the capability released the lease, the handle can never
        // be consumed again and its stale disposer stays a no-op.
        expect(result.handle.consume()).toEqual({ ok: false, reason: 'already-consumed' })
        result.handle.dispose()
        expect(result.handle.isDisposed()).toBe(true)
        expect(coordinator.currentHolder()).toBeNull()
      } finally {
        result.handle.dispose()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Failure-shape helpers (narrowing for the structured failure union)
// ---------------------------------------------------------------------------

function resultFailureCode(result: Extract<PromotionPreparationResult, { ok: false }>): string {
  return result.failure.code
}

function resultFailureSafeCode(result: Extract<PromotionPreparationResult, { ok: false }>): string | null {
  return result.failure.safeCode
}
