/**
 * Promotion preparation tests (Phase 4.4.1, LOCK-4411..LOCK-4417).
 *
 * Tests the exact-once promotion preparation gate: lease acquisition →
 * snapshot creation/validation/publish → journal write → prepared handle.
 *
 * Coverage:
 * - Happy path: full ordering, prepared handle carries correct fields,
 *   dispose releases lease.
 * - Lease busy: preparation returns structured failure when backup/init/
 *   restore/close/other promotion holds the slot.
 * - Snapshot failure at every sub-step (backup, validation, publish):
 *   old retained preserved, lease released, structured failure returned.
 * - Journal write failure: snapshot retained but journal not written,
 *   lease released, structured failure returned.
 * - Dispose idempotency: double-dispose is a safe no-op.
 * - Prepared handle exact-once alignment with the claim token.
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
import { ROLLBACK_SNAPSHOT_FILENAME, ROLLBACK_SNAPSHOT_STAGING_FILENAME } from '../journal'
import { getPromotionJournalPath, readPromotionJournal } from '../journalStore'
import type { ClaimHandleLike } from '../preparation'
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

function makeClaim(overrides?: Partial<ClaimHandleLike>): ClaimHandleLike {
  return {
    token: 'promotion-test-token-abc123',
    sessionId: 'import-test-session',
    candidateId: 'candidate-import-test-session',
    dbPath: '/mock/candidate/path/chat.db',
    ...overrides
  }
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
      const claim = makeClaim()
      const result = await preparePromotion(claim, tempDir, () => live.sqlite, coordinator)

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
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

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

    it('writes a snapshot-ready journal', async () => {
      const claim = makeClaim()
      const result = await preparePromotion(claim, tempDir, () => live.sqlite, coordinator)

      expect(result.ok).toBe(true)

      const journalResult = await readPromotionJournal(tempDir)
      expect(journalResult.status).toBe('valid')
      if (journalResult.status !== 'valid') return

      expect(journalResult.journal.phase).toBe('snapshot-ready')
      expect(journalResult.journal.sessionId).toBe(claim.sessionId)
      expect(journalResult.journal.candidateId).toBe(claim.candidateId)
      expect(journalResult.journal.version).toBe(1)
    })

    it('holds the promotion maintenance lease until dispose', async () => {
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

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
      await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

      expect(live.sqlite.open).toBe(true)
      const count = live.sqlite.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
      expect(count.c).toBe(1)
    })

    it('no staging artifact remains after success', async () => {
      await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

      expect(realFs.existsSync(realPath.join(tempDir, ROLLBACK_SNAPSHOT_STAGING_FILENAME))).toBe(false)
      expect(realFs.existsSync(`${retainedPath}-wal`)).toBe(false)
      expect(realFs.existsSync(`${retainedPath}-shm`)).toBe(false)
    })

    it('no live WAL/SHM sidecars are deleted', async () => {
      const walPath = `${live.dbPath}-wal`
      const shmPath = `${live.dbPath}-shm`
      expect(realFs.existsSync(walPath)).toBe(true)
      expect(realFs.existsSync(shmPath)).toBe(true)

      await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

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

      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.failure.phase).toBe('acquire-lease')
      expect(result.failure.code).toBe('LEASE_BUSY')

      // Foreign holder is undisturbed.
      expect(coordinator.currentHolder()).toEqual({ kind, ownerId })
    })

    it('returns LEASE_BUSY when another promotion is in progress', async () => {
      const other = acquirePromotionLease('other-session', coordinator)

      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

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

      const result = await preparePromotion(makeClaim(), tempDir, () => detached, coordinator)

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
      const result = await preparePromotion(
        makeClaim(),
        tempDir,
        () => {
          throw new Error('no db')
        },
        coordinator
      )

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

      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('validate-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('SNAPSHOT_MIGRATION_INCOMPATIBLE')
      }
      // No journal is ever written for a failed preparation.
      expect(realFs.existsSync(journalPath)).toBe(false)
      expect(coordinator.currentHolder()).toBeNull()
    })

    it('maps a publish failure to phase publish-snapshot', async () => {
      // A directory at the retained path makes the atomic rename fail.
      realFs.mkdirSync(retainedPath)

      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('publish-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('RETAINED_PUBLISH_FAILED')
      }
      expect(realFs.existsSync(journalPath)).toBe(false)
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

      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
      openSpy.mockRestore()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.phase).toBe('publish-snapshot')
        expect(result.failure.code).toBe('SNAPSHOT_FAILED')
        expect(result.failure.safeCode).toBe('RETAINED_DIRECTORY_SYNC_FAILED')
      }
      // The unconfirmed-durability snapshot can NEVER be journaled: a crash
      // could surface a journal pointing at a rename that was never durable.
      expect(realFs.existsSync(journalPath)).toBe(false)
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
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
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
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
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
      const claim = makeClaim()
      const result = await preparePromotion(claim, tempDir, () => live.sqlite, coordinator)
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
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
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
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      result.handle.dispose()
      expect(coordinator.currentHolder()).toBeNull()

      const consumeResult = result.handle.consume()
      expect(consumeResult).toEqual({ ok: false, reason: 'disposed' })
    })

    it('stale disposer after consume does NOT release the transferred lease', async () => {
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
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
      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
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
      const claim = makeClaim({ token })
      const result = await preparePromotion(claim, tempDir, () => live.sqlite, coordinator)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.handle.token).toBe(token)
      result.handle.dispose()
    })

    it('different claims produce different handles with different tokens', async () => {
      const claimA = makeClaim({ token: 'token-a', sessionId: 'session-a', candidateId: 'candidate-session-a' })
      const claimB = makeClaim({ token: 'token-b', sessionId: 'session-b', candidateId: 'candidate-session-b' })

      const resultA = await preparePromotion(claimA, tempDir, () => live.sqlite, coordinator)
      expect(resultA.ok).toBe(true)
      if (resultA.ok) resultA.handle.dispose()

      const resultB = await preparePromotion(claimB, tempDir, () => live.sqlite, coordinator)
      expect(resultB.ok).toBe(true)
      if (resultB.ok) resultB.handle.dispose()

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

      const result = await preparePromotion(makeClaim(), tempDir, () => live.sqlite, coordinator)
      expect(result.ok).toBe(true)
      if (result.ok) result.handle.dispose()

      // The preparation function wrote the journal, not the snapshot unit.
      expect(realFs.existsSync(journalPath)).toBe(true)
    })
  })
})
