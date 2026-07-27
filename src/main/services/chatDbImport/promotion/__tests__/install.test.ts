/**
 * installCandidate + mintClosedLiveProof tests — real FS + real
 * better-sqlite3 (Phase 4.4.2, LOCK-4423/4425/4426/4427).
 *
 * Covers:
 * - Success: sidecars removed, atomic rename, parent sync, destination
 *   identity confirmation, branded receipt binding source identity.
 * - Closed-live proof: unforgeable brand, mint refusals (invalid/released
 *   authorization, open live), install refusals (forged, consumed, stale
 *   authorization, witness flip, owner mismatch), single-use consumption
 *   only when the destructive window opens.
 * - Pre-install failures: invalid/traversal candidate IDs, source missing,
 *   not sealed (provable via candidate sidecars), sidecar deletion
 *   failure, pre-rename interruption, EXDEV (never copy fallback), rename
 *   error — live DB file untouched.
 * - Post-install failures: parent sync failure after rename, destination
 *   identity mismatch — rename retained, no rollback/cleanup (LOCK-4425).
 */

import * as realFs from 'node:fs'
// Default export (mutable object) — spy target for bounded fault injection;
// the production module imports the same default object.
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
  type PromotionLeaseHandle
} from '../../../chatDb/maintenanceCoordination'
import { runMigrations } from '../../../chatDb/migration'
import * as schema from '../../../chatDb/schema'
import { CANDIDATE_DB_FILENAME, CANDIDATE_ROOT_DIRNAME } from '../../candidateDb'
import type { CandidateInstallResult, ClosedLiveProof } from '../install'
import { installCandidate, isInstallReceipt, mintClosedLiveProof } from '../install'
import { ROLLBACK_SNAPSHOT_FILENAME } from '../journal'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CANDIDATE_ID = 'candidate-session-1'
const RETAINED_SENTINEL = Buffer.from('retained-rollback-snapshot-sentinel')

function makeTempDir(): string {
  return realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-install-'))
}

/** Create + migrate + seed a chat.db with `topicCount` topics, then close. */
function makeSealedDb(dbPath: string, topicCount: number): void {
  realFs.mkdirSync(realPath.dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  runMigrations(db, sqlite)
  for (let i = 0; i < topicCount; i++) {
    sqlite
      .prepare(
        `INSERT INTO topics (id, assistant_id, name, created_at, updated_at, deleted_at, extra)
         VALUES (?, 'a-1', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL, '{}')`
      )
      .run(`t-${i}`, `Topic ${i}`)
  }
  sqlite.close()
}

function countTopics(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  const row = db.prepare('SELECT count(*) AS c FROM topics').get() as { c: number }
  db.close()
  return row.c
}

describe('installCandidate', () => {
  let dataRoot: string
  let livePath: string
  let sourcePath: string
  let retainedPath: string
  let coordinator: MaintenanceCoordinator
  let authorization: PromotionLeaseHandle
  let liveClosed: boolean

  beforeEach(() => {
    dataRoot = makeTempDir()
    livePath = realPath.join(dataRoot, 'chat.db')
    sourcePath = realPath.join(dataRoot, CANDIDATE_ROOT_DIRNAME, CANDIDATE_ID, CANDIDATE_DB_FILENAME)
    retainedPath = realPath.join(dataRoot, ROLLBACK_SNAPSHOT_FILENAME)

    // Live DB: 2 topics, closed (authorized close already happened).
    makeSealedDb(livePath, 2)
    // Sealed owned candidate: 3 topics.
    makeSealedDb(sourcePath, 3)
    // Retained rollback snapshot artifact that must never be cleaned up.
    realFs.writeFileSync(retainedPath, RETAINED_SENTINEL)
    // Fake live sidecars left behind (deleted only under a verified proof).
    realFs.writeFileSync(`${livePath}-wal`, 'stale-wal')
    realFs.writeFileSync(`${livePath}-shm`, 'stale-shm')

    coordinator = createMaintenanceCoordinator()
    authorization = acquirePromotionLease(CANDIDATE_ID, coordinator)
    liveClosed = true
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  function mintProof(): ClosedLiveProof {
    const minted = mintClosedLiveProof({
      authorization,
      witness: { isLiveClosed: () => liveClosed },
      coordinator
    })
    expect(minted.ok).toBe(true)
    if (!minted.ok) throw new Error('unreachable')
    return minted.proof
  }

  function run(
    proof: ClosedLiveProof,
    extra?: Partial<Parameters<typeof installCandidate>[0]>
  ): CandidateInstallResult {
    return installCandidate({ candidateId: CANDIDATE_ID, proof, dataRoot, ...extra })
  }

  /** Live chat.db file untouched (still the old 2-topic DB), source retained. */
  function expectLiveUntouched(): void {
    expect(countTopics(livePath)).toBe(2)
    expect(realFs.existsSync(sourcePath)).toBe(true)
  }

  /** Retained snapshot artifact byte-for-byte untouched (LOCK-4425). */
  function expectRetainedUntouched(): void {
    expect(realFs.readFileSync(retainedPath).equals(RETAINED_SENTINEL)).toBe(true)
  }

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  it('installs the sealed candidate durably and returns an identity-bound branded receipt', () => {
    const sourceStat = realFs.statSync(sourcePath, { bigint: true })

    const result = run(mintProof())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Live sidecars were removed under the verified proof. Checked BEFORE
    // any SQLite open below (an open would recreate fresh WAL/SHM files).
    expect(realFs.existsSync(`${livePath}-wal`)).toBe(false)
    expect(realFs.existsSync(`${livePath}-shm`)).toBe(false)

    // Live path now holds the candidate content; the source is gone.
    expect(countTopics(livePath)).toBe(3)
    expect(realFs.existsSync(sourcePath)).toBe(false)

    // Receipt binds the SOURCE file object identity to the live path.
    expect(isInstallReceipt(result.receipt)).toBe(true)
    expect(result.receipt.candidateId).toBe(CANDIDATE_ID)
    expect(result.receipt.livePath).toBe(livePath)
    expect(result.receipt.identity.dev).toBe(sourceStat.dev)
    expect(result.receipt.identity.ino).toBe(sourceStat.ino)
    expect(result.receipt.identity.size).toBe(sourceStat.size)
    const liveStat = realFs.statSync(livePath, { bigint: true })
    expect(liveStat.ino).toBe(sourceStat.ino)

    // Retained snapshot untouched (LOCK-4425/4428 — never cleaned up).
    expectRetainedUntouched()
  })

  it('consumes the proof exactly once: a second install with the same proof is refused', () => {
    const proof = mintProof()
    expect(run(proof).ok).toBe(true)

    const again = run(proof)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.phase).toBe('pre-install')
    expect(again.code).toBe('CLOSED_LIVE_PROOF_INVALID')
    expect(again.safeCode).toBe('CONSUMED')
  })

  // -------------------------------------------------------------------------
  // Closed-live proof — mint refusals (LOCK-4427)
  // -------------------------------------------------------------------------

  it('refuses to mint a proof while the live DB witness reports open handles', () => {
    liveClosed = false
    const minted = mintClosedLiveProof({
      authorization,
      witness: { isLiveClosed: () => liveClosed },
      coordinator
    })
    expect(minted.ok).toBe(false)
    if (minted.ok) return
    expect(minted.reason).toBe('live-not-closed')
  })

  it('refuses to mint a proof for a released promotion authorization', () => {
    authorization.release()
    const minted = mintClosedLiveProof({
      authorization,
      witness: { isLiveClosed: () => true },
      coordinator
    })
    expect(minted.ok).toBe(false)
    if (minted.ok) return
    expect(minted.reason).toBe('authorization-invalid')
    if (minted.reason === 'authorization-invalid') {
      expect(minted.authorizationReason).toBe('released')
    }
  })

  it('refuses to mint a proof for a forged authorization handle', () => {
    const forged: PromotionLeaseHandle = {
      ownerId: CANDIDATE_ID,
      isReleased: () => false,
      release: () => true
    }
    const minted = mintClosedLiveProof({
      authorization: forged,
      witness: { isLiveClosed: () => true },
      coordinator
    })
    expect(minted.ok).toBe(false)
    if (minted.ok) return
    expect(minted.reason).toBe('authorization-invalid')
  })

  // -------------------------------------------------------------------------
  // Closed-live proof — install refusals: NO sidecar deletion happens
  // -------------------------------------------------------------------------

  function expectProofRefusal(result: CandidateInstallResult, safeCode: string): void {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.phase).toBe('pre-install')
    expect(result.code).toBe('CLOSED_LIVE_PROOF_INVALID')
    expect(result.safeCode).toBe(safeCode)
    // The destructive window never opened: live sidecars still present.
    expect(realFs.existsSync(`${livePath}-wal`)).toBe(true)
    expect(realFs.existsSync(`${livePath}-shm`)).toBe(true)
    expectLiveUntouched()
  }

  it('refuses a forged proof object (module brand, LOCK-4427)', () => {
    const forged = Object.freeze({ ownerId: CANDIDATE_ID }) as ClosedLiveProof
    expectProofRefusal(run(forged), 'UNRECOGNIZED')
  })

  it('refuses a proof whose authorization was released after minting', () => {
    const proof = mintProof()
    authorization.release()
    expectProofRefusal(run(proof), 'AUTHORIZATION_RELEASED')
  })

  it('refuses a proof when the witness reports the live DB reopened (TOCTOU re-check)', () => {
    const proof = mintProof()
    liveClosed = false
    expectProofRefusal(run(proof), 'LIVE_NOT_CLOSED')
  })

  it('refuses a proof minted for a different promotion owner (candidate binding)', () => {
    authorization.release()
    const otherAuthorization = acquirePromotionLease('candidate-other', coordinator)
    const minted = mintClosedLiveProof({
      authorization: otherAuthorization,
      witness: { isLiveClosed: () => true },
      coordinator
    })
    expect(minted.ok).toBe(true)
    if (!minted.ok) return
    expectProofRefusal(run(minted.proof), 'OWNER_MISMATCH')
  })

  // -------------------------------------------------------------------------
  // Pre-install failures — live file untouched, proof not consumed
  // -------------------------------------------------------------------------

  function expectPreInstallFailure(result: CandidateInstallResult, code: string, safeCode?: string): void {
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.phase).toBe('pre-install')
    expect(result.code).toBe(code)
    if (safeCode !== undefined) expect(result.safeCode).toBe(safeCode)
    expect(countTopics(livePath)).toBe(2)
    expectRetainedUntouched()
  }

  it('refuses a candidate ID without the owned prefix', () => {
    const result = installCandidate({ candidateId: 'session-1', proof: mintProof(), dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_ID_INVALID', 'ID_ALLOWLIST_REJECTED')
  })

  it('refuses a traversal candidate ID', () => {
    const result = installCandidate({ candidateId: '../evil', proof: mintProof(), dataRoot })
    expectPreInstallFailure(result, 'CANDIDATE_ID_INVALID', 'ID_ALLOWLIST_REJECTED')
  })

  it('fails with CANDIDATE_MISSING when the source DB does not exist, leaving the proof reusable', () => {
    realFs.rmSync(realPath.dirname(sourcePath), { recursive: true, force: true })
    const proof = mintProof()

    expectPreInstallFailure(run(proof), 'CANDIDATE_MISSING', 'ENOENT')
    // Proof was NOT consumed: recreate the candidate and retry with it.
    makeSealedDb(sourcePath, 3)
    expect(run(proof).ok).toBe(true)
  })

  it('fails with CANDIDATE_NOT_SEALED when a candidate WAL sidecar is present (provable unsealed state)', () => {
    realFs.writeFileSync(`${sourcePath}-wal`, 'candidate-wal')
    const proof = mintProof()

    expectPreInstallFailure(run(proof), 'CANDIDATE_NOT_SEALED', 'SIDECAR_PRESENT')
    // Sidecar deletion never ran (proof unconsumed, live sidecars intact).
    expect(realFs.existsSync(`${livePath}-wal`)).toBe(true)

    // Sealing the candidate (sidecar gone) makes the same proof succeed.
    realFs.unlinkSync(`${sourcePath}-wal`)
    expect(run(proof).ok).toBe(true)
  })

  it('fails with LIVE_SIDECAR_DELETE_FAILED when a live sidecar cannot be unlinked', () => {
    // A non-empty directory at the sidecar path makes unlinkSync fail.
    realFs.rmSync(`${livePath}-wal`)
    realFs.mkdirSync(`${livePath}-wal`)
    realFs.writeFileSync(realPath.join(`${livePath}-wal`, 'x'), 'x')

    const result = run(mintProof())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.phase).toBe('pre-install')
    expect(result.code).toBe('LIVE_SIDECAR_DELETE_FAILED')
    // Remove the injected directory so the untouched live DB can be read.
    realFs.rmSync(`${livePath}-wal`, { recursive: true, force: true })
    expect(countTopics(livePath)).toBe(2)
    expect(realFs.existsSync(sourcePath)).toBe(true)
    expectRetainedUntouched()
  })

  it('fails pre-install when interrupted between source fsync and rename', () => {
    const result = run(mintProof(), {
      onBeforeRename: () => {
        throw new Error('simulated crash before rename')
      }
    })
    expectPreInstallFailure(result, 'RENAME_FAILED')
    expect(realFs.existsSync(sourcePath)).toBe(true)
  })

  it('fails with RENAME_CROSS_DEVICE on EXDEV and NEVER falls back to a copy (LOCK-4426)', () => {
    const liveBytesBefore = realFs.readFileSync(livePath)
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      const error: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted')
      error.code = 'EXDEV'
      throw error
    })
    const copySpy = vi.spyOn(nodeFs, 'copyFileSync')

    const result = run(mintProof())
    renameSpy.mockRestore()

    expectPreInstallFailure(result, 'RENAME_CROSS_DEVICE', 'EXDEV')
    // No copy fallback of any kind: live bytes are untouched, source intact.
    expect(copySpy).not.toHaveBeenCalled()
    expect(realFs.readFileSync(livePath).equals(liveBytesBefore)).toBe(true)
    expect(realFs.existsSync(sourcePath)).toBe(true)
  })

  it('fails with RENAME_FAILED for a non-EXDEV rename error', () => {
    const renameSpy = vi.spyOn(nodeFs, 'renameSync').mockImplementation(() => {
      const error: NodeJS.ErrnoException = new Error('EACCES: permission denied')
      error.code = 'EACCES'
      throw error
    })

    const result = run(mintProof())
    renameSpy.mockRestore()

    expectPreInstallFailure(result, 'RENAME_FAILED', 'EACCES')
    expect(realFs.existsSync(sourcePath)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Post-install failures — rename retained, no rollback (LOCK-4425)
  // -------------------------------------------------------------------------

  it('classifies a parent-directory sync failure after the rename as post-install and retains artifacts', () => {
    // Bounded injection: fail ONLY the directory open used by the parent
    // fsync; the source-file fsync and every other open pass through.
    const realOpenSync = nodeFs.openSync
    const openSpy = vi.spyOn(nodeFs, 'openSync').mockImplementation(((
      filePath: realFs.PathLike,
      flags: realFs.OpenMode,
      mode?: realFs.Mode | null
    ) => {
      if (filePath === dataRoot) {
        const error: NodeJS.ErrnoException = new Error('EIO: injected directory fsync failure')
        error.code = 'EIO'
        throw error
      }
      return realOpenSync(filePath, flags, mode)
    }) as typeof realFs.openSync)

    const result = run(mintProof())
    openSpy.mockRestore()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.phase).toBe('post-install')
    expect(result.code).toBe('LIVE_DIRECTORY_SYNC_FAILED')
    expect(result.safeCode).toBe('EIO')
    // The rename already happened and is RETAINED (no rollback, LOCK-4425).
    expect(countTopics(livePath)).toBe(3)
    expect(realFs.existsSync(sourcePath)).toBe(false)
    expectRetainedUntouched()
  })

  it('fails with DESTINATION_IDENTITY_MISMATCH when the live file is swapped after the rename', () => {
    const result = run(mintProof(), {
      onAfterRename: () => {
        // Replace the just-installed live file with a different file object.
        realFs.rmSync(livePath)
        realFs.writeFileSync(livePath, 'not-the-installed-candidate')
      }
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.phase).toBe('post-install')
    expect(result.code).toBe('DESTINATION_IDENTITY_MISMATCH')
    // No rollback/cleanup: whatever sits at the live path is retained.
    expect(realFs.existsSync(livePath)).toBe(true)
    expectRetainedUntouched()
  })

  it('never returns a branded receipt on failure', () => {
    const result = run(mintProof(), {
      onAfterRename: () => {
        realFs.rmSync(livePath)
        realFs.writeFileSync(livePath, 'swapped')
      }
    })
    expect(result.ok).toBe(false)
    expect(isInstallReceipt({ candidateId: CANDIDATE_ID, livePath })).toBe(false)
  })
})
