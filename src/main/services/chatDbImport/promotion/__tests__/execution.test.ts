/**
 * Destructive promotion executor tests (Phase 4.4.2, LOCK-4421..4428).
 *
 * Real temp-dir filesystem + REAL journal store + REAL closed-live-proof
 * minting against a REAL maintenance coordinator/lease; the install and
 * verify primitives are high-fidelity injected fakes that perform genuine
 * filesystem effects (sidecar deletion + true rename), grouping the
 * equivalent bounded gates already covered by the real install/verifier
 * suites. Every test asserts the physical invariants explicitly:
 * live bytes, sidecars, durable journal phase, retained snapshot bytes,
 * lease holder, and that the executor NEVER releases the lease itself and
 * never rolls back / cleans up / relaunches.
 *
 * Fault-class coverage (executor-local classes of the 23-point map):
 * C5–C18 and C19/C20 abort classes — see the class tags on each test.
 */

import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import {
  acquirePromotionLease,
  createMaintenanceCoordinator,
  type MaintenanceCoordinator,
  type PromotionLeaseHandle,
  validatePromotionAuthorization
} from '../../../chatDb/maintenanceCoordination'
import type { PromotionExecutionPrimitives, PromotionExecutor } from '../execution'
import { createPromotionExecutor } from '../execution'
import type { CandidateInstallResult, InstallReceipt } from '../install'
import { PROMOTION_JOURNAL_FILENAME, ROLLBACK_SNAPSHOT_FILENAME } from '../journal'
import { readPromotionJournal, writeSnapshotReadyPromotionJournal } from '../journalStore'
import type { ExecutingPromotionCapability } from '../preparation'
import type { ReplacementVerificationResult } from '../replacementVerifier'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const SESSION_ID = 'import-exec-session'
const CANDIDATE_ID = 'candidate-import-exec-session'
const LIVE_ORIGINAL = Buffer.from('live-original-bytes')
const CANDIDATE_BYTES = Buffer.from('candidate-installed-bytes')
const RETAINED_SENTINEL = Buffer.from('retained-rollback-snapshot-sentinel')

let dataRoot: string
let livePath: string
let retainedPath: string
let candidatePath: string
let coordinator: MaintenanceCoordinator
let authorization: PromotionLeaseHandle
let capability: ExecutingPromotionCapability
let releaseSpy: ReturnType<typeof vi.fn>

interface LiveDbFake {
  state: { open: boolean }
  closeForPromotion: ReturnType<typeof vi.fn>
  reopenForPromotion: ReturnType<typeof vi.fn>
  isInitialised: ReturnType<typeof vi.fn>
}

let liveDb: LiveDbFake

function makeLiveDb(): LiveDbFake {
  const state = { open: true }
  const fake: LiveDbFake = {
    state,
    closeForPromotion: vi.fn((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`promotion authorization invalid (${verdict.reason})`)
      state.open = false
      return true
    }),
    reopenForPromotion: vi.fn(async (auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`promotion authorization invalid (${verdict.reason})`)
      state.open = true
    }),
    isInitialised: vi.fn(() => state.open)
  }
  return fake
}

/** High-fidelity install fake: deletes live sidecars, true atomic rename. */
function makeInstallOk() {
  return vi.fn((options: { candidateId: string }): CandidateInstallResult => {
    realFs.rmSync(`${livePath}-wal`, { force: true })
    realFs.rmSync(`${livePath}-shm`, { force: true })
    realFs.renameSync(candidatePath, livePath)
    const receipt: InstallReceipt = {
      candidateId: options.candidateId,
      livePath,
      identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
      installedAtMs: 0
    }
    return { ok: true as const, receipt }
  })
}

function makeVerifyOk() {
  return vi.fn((): ReplacementVerificationResult => ({ ok: true as const }))
}

let installFake: ReturnType<typeof makeInstallOk>
let verifyFake: ReturnType<typeof makeVerifyOk>

function makeExecutor(primitives: Partial<PromotionExecutionPrimitives> = {}): PromotionExecutor {
  return createPromotionExecutor({
    capability,
    dataRoot,
    liveDb,
    coordinator,
    primitives: {
      install: installFake as unknown as PromotionExecutionPrimitives['install'],
      verify: verifyFake as unknown as PromotionExecutionPrimitives['verify'],
      ...primitives
    }
  })
}

async function journalPhase(): Promise<string> {
  const read = await readPromotionJournal(dataRoot)
  expect(read.status).toBe('valid')
  return read.status === 'valid' ? read.journal.phase : 'unreadable'
}

function liveBytes(): Buffer {
  return realFs.readFileSync(livePath)
}

function sidecarsPresent(): boolean {
  return realFs.existsSync(`${livePath}-wal`) && realFs.existsSync(`${livePath}-shm`)
}

/** Retained snapshot byte-for-byte untouched — no rollback, no cleanup (LOCK-4425/4428). */
function expectRetainedUntouched(): void {
  expect(realFs.readFileSync(retainedPath).equals(RETAINED_SENTINEL)).toBe(true)
}

/** The SAME promotion lease is still the current holder (LOCK-4422). */
function expectLeaseStillHeld(): void {
  expect(capability.isReleased()).toBe(false)
  expect(coordinator.currentHolder()).toEqual({ kind: 'promotion', ownerId: CANDIDATE_ID })
}

beforeEach(async () => {
  dataRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chatdb-exec-'))
  livePath = realPath.join(dataRoot, 'chat.db')
  retainedPath = realPath.join(dataRoot, ROLLBACK_SNAPSHOT_FILENAME)
  candidatePath = realPath.join(dataRoot, 'candidates', CANDIDATE_ID, 'chat.db')

  realFs.writeFileSync(livePath, LIVE_ORIGINAL)
  realFs.writeFileSync(`${livePath}-wal`, 'stale-wal')
  realFs.writeFileSync(`${livePath}-shm`, 'stale-shm')
  realFs.writeFileSync(retainedPath, RETAINED_SENTINEL)
  realFs.mkdirSync(realPath.dirname(candidatePath), { recursive: true })
  realFs.writeFileSync(candidatePath, CANDIDATE_BYTES)

  coordinator = createMaintenanceCoordinator()
  authorization = acquirePromotionLease(CANDIDATE_ID, coordinator)
  releaseSpy = vi.fn(() => {
    authorization.release()
  })
  capability = {
    token: 'promotion-exec-token',
    sessionId: SESSION_ID,
    candidateId: CANDIDATE_ID,
    retainedSnapshotPath: retainedPath,
    candidateDbPath: candidatePath,
    authorization,
    release: releaseSpy as unknown as ExecutingPromotionCapability['release'],
    isReleased: () => authorization.isReleased()
  }

  liveDb = makeLiveDb()
  installFake = makeInstallOk()
  verifyFake = makeVerifyOk()

  // Durable snapshot-ready journal — the Phase 4.4.1 end state.
  await writeSnapshotReadyPromotionJournal(
    { version: 1, sessionId: SESSION_ID, candidateId: CANDIDATE_ID, phase: 'snapshot-ready' },
    dataRoot
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  realFs.rmSync(dataRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Success path + sequence ordering (C18)
// ---------------------------------------------------------------------------

describe('promotion executor — success path', () => {
  it('C18: executes the exact non-reorderable sequence and stops at the replacement-verified handoff', async () => {
    const trace: string[] = []
    liveDb.closeForPromotion.mockImplementation((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      trace.push('close')
      liveDb.state.open = false
      return true
    })
    liveDb.reopenForPromotion.mockImplementation(async (auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      trace.push('reopen')
      liveDb.state.open = true
    })
    const { mintClosedLiveProof } = await import('../install')
    const { advancePromotionJournalToCandidateInstalled, advancePromotionJournalToReplacementVerified } = await import(
      '../journalStore'
    )
    installFake.mockImplementation((options: { candidateId: string }) => {
      trace.push('install')
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath)
      const receipt: InstallReceipt = {
        candidateId: options.candidateId,
        livePath,
        identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
        installedAtMs: 0
      }
      return { ok: true as const, receipt }
    })
    verifyFake.mockImplementation(() => {
      trace.push('verify')
      return { ok: true as const }
    })

    const executor = makeExecutor({
      mintProof: ((options: Parameters<typeof mintClosedLiveProof>[0]) => {
        trace.push('mint')
        return mintClosedLiveProof(options)
      }) as PromotionExecutionPrimitives['mintProof'],
      advanceCandidateInstalled: (async (journal, root) => {
        trace.push('journal-candidate-installed')
        await advancePromotionJournalToCandidateInstalled(journal, root)
      }) as PromotionExecutionPrimitives['advanceCandidateInstalled'],
      advanceReplacementVerified: (async (journal, root) => {
        trace.push('journal-replacement-verified')
        await advancePromotionJournalToReplacementVerified(journal, root)
      }) as PromotionExecutionPrimitives['advanceReplacementVerified']
    })

    const result = await executor.run()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Exact, non-reorderable order (LOCK-4423/4424/4427).
    expect(trace).toEqual([
      'close',
      'mint',
      'install',
      'journal-candidate-installed',
      'reopen',
      'verify',
      'journal-replacement-verified'
    ])

    // Durable end state: replacement-verified, nothing cleaned (LOCK-4428).
    expect(await journalPhase()).toBe('replacement-verified')
    expect(realFs.existsSync(realPath.join(dataRoot, PROMOTION_JOURNAL_FILENAME))).toBe(true)
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true)
    expect(sidecarsPresent()).toBe(false)
    expectRetainedUntouched()
    expect(liveDb.state.open).toBe(true)

    // Handoff still owns the SAME capability/lease — never released here.
    expect(result.handoff.capability).toBe(capability)
    expect(result.handoff.token).toBe('promotion-exec-token')
    expect(result.handoff.sessionId).toBe(SESSION_ID)
    expect(result.handoff.candidateId).toBe(CANDIDATE_ID)
    expect(result.handoff.retainedSnapshotPath).toBe(retainedPath)
    expect(releaseSpy).not.toHaveBeenCalled()
    expectLeaseStillHeld()
    expect(executor.isSettled()).toBe(true)
    expect(executor.subphase()).toBe('settled')
  })

  it('C18: validates the capability at every irreversible boundary (5 boundary gates)', async () => {
    const validateSpy = vi.fn(validatePromotionAuthorization)
    const executor = makeExecutor({
      validateAuthorization: validateSpy as PromotionExecutionPrimitives['validateAuthorization']
    })
    const result = await executor.run()
    expect(result.ok).toBe(true)
    // close, install, journal-candidate-installed, reopen(pre), journal-replacement-verified
    expect(validateSpy).toHaveBeenCalledTimes(5)
    for (const call of validateSpy.mock.calls) {
      expect(call[0]).toBe(authorization)
      expect(call[1]).toBe(coordinator)
    }
  })

  it('run() is exact-once: a second run() throws without side effects', async () => {
    const executor = makeExecutor()
    const result = await executor.run()
    expect(result.ok).toBe(true)
    await expect(executor.run()).rejects.toThrow(/exact-once/)
    expect(installFake).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Pre-install fault classes (C5–C11, C19)
// ---------------------------------------------------------------------------

describe('promotion executor — pre-install faults', () => {
  /** Shared pre-install invariants: live untouched, journal snapshot-ready, snapshot retained, lease per test. */
  async function expectPreInstallUntouched(): Promise<void> {
    expect(liveBytes().equals(LIVE_ORIGINAL)).toBe(true)
    expect(await journalPhase()).toBe('snapshot-ready')
    expectRetainedUntouched()
  }

  it('C5: stale capability before close — refused with no destructive action', async () => {
    authorization.release() // lease gone: stale capability cannot act (LOCK-4422)
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'closing-live',
      classification: 'pre-install',
      recoveryRequired: false,
      code: 'CAPABILITY_STALE',
      safeCode: 'released',
      liveDisposition: 'open'
    })
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expect(installFake).not.toHaveBeenCalled()
    expect(sidecarsPresent()).toBe(true)
    await expectPreInstallUntouched()
  })

  it('C6: closeForPromotion throws — live stays open, nothing after close runs', async () => {
    liveDb.closeForPromotion.mockImplementation(() => {
      throw new Error('close blew up')
    })
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'closing-live',
      classification: 'pre-install',
      code: 'LIVE_CLOSE_FAILED',
      liveDisposition: 'open'
    })
    expect(installFake).not.toHaveBeenCalled()
    expect(liveDb.reopenForPromotion).not.toHaveBeenCalled() // never closed — no reopen
    expect(sidecarsPresent()).toBe(true)
    await expectPreInstallUntouched()
    expectLeaseStillHeld()
  })

  it('C7: closeForPromotion returns false (close-core failure) — handle preserved, no mint/install', async () => {
    liveDb.closeForPromotion.mockImplementation(() => false)
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'closing-live',
      classification: 'pre-install',
      code: 'LIVE_CLOSE_FAILED',
      safeCode: 'CLOSE_RETURNED_FALSE',
      liveDisposition: 'open'
    })
    expect(installFake).not.toHaveBeenCalled()
    expect(sidecarsPresent()).toBe(true)
    await expectPreInstallUntouched()
    expectLeaseStillHeld()
  })

  it('C8: honest witness refuses the proof when close did not actually release handles (LOCK-4427)', async () => {
    // Dishonest close: reports success but the lifecycle witness still
    // sees open handles — the real mint must refuse.
    liveDb.closeForPromotion.mockImplementation(() => true)
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'minting-proof',
      classification: 'pre-install',
      code: 'PROOF_MINT_FAILED',
      safeCode: 'LIVE_NOT_CLOSED',
      liveDisposition: 'open'
    })
    expect(installFake).not.toHaveBeenCalled()
    expect(sidecarsPresent()).toBe(true) // sidecars NEVER deleted while live open (LOCK-4427)
    await expectPreInstallUntouched()
    expectLeaseStillHeld()
  })

  it('C9: proof mint refused for stale authorization (grouped gate with C8, distinct safeCode)', async () => {
    const { mintClosedLiveProof } = await import('../install')
    const executor = makeExecutor({
      mintProof: ((options: Parameters<typeof mintClosedLiveProof>[0]) => {
        // The lease is stolen/released between close and mint.
        authorization.release()
        return mintClosedLiveProof(options)
      }) as PromotionExecutionPrimitives['mintProof']
    })
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'minting-proof',
      classification: 'pre-install',
      code: 'PROOF_MINT_FAILED',
      safeCode: 'AUTHORIZATION_RELEASED',
      // Stale authorization also blocks the availability reopen: closed.
      liveDisposition: 'closed'
    })
    expect(installFake).not.toHaveBeenCalled()
    await expectPreInstallUntouched()
  })

  it('C10: pre-install install failure — live bytes unchanged, availability restored by authorized reopen', async () => {
    installFake.mockImplementation(() => ({
      ok: false as const,
      phase: 'pre-install' as const,
      code: 'CANDIDATE_MISSING' as const,
      safeCode: 'ENOENT'
    }))
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'installing',
      classification: 'pre-install',
      recoveryRequired: false,
      code: 'INSTALL_FAILED',
      safeCode: 'CANDIDATE_MISSING:ENOENT',
      liveDisposition: 'open'
    })
    // Availability restoration with the SAME authorization — not a rollback.
    expect(liveDb.reopenForPromotion).toHaveBeenCalledTimes(1)
    expect(liveDb.state.open).toBe(true)
    await expectPreInstallUntouched()
    expectLeaseStillHeld()
    expect(verifyFake).not.toHaveBeenCalled()
  })

  it('C11: RENAME_CROSS_DEVICE is terminal pre-install — never a copy fallback (LOCK-4426)', async () => {
    installFake.mockImplementation(() => ({
      ok: false as const,
      phase: 'pre-install' as const,
      code: 'RENAME_CROSS_DEVICE' as const,
      safeCode: 'EXDEV'
    }))
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      code: 'INSTALL_FAILED',
      classification: 'pre-install',
      safeCode: 'RENAME_CROSS_DEVICE:EXDEV'
    })
    // No copy fallback: live bytes original, candidate still in place.
    expect(liveBytes().equals(LIVE_ORIGINAL)).toBe(true)
    expect(realFs.readFileSync(candidatePath).equals(CANDIDATE_BYTES)).toBe(true)
    expect(await journalPhase()).toBe('snapshot-ready')
    expectRetainedUntouched()
    expectLeaseStillHeld()
  })

  it('C19: abort requested before run — nothing destructive happens', async () => {
    const executor = makeExecutor()
    executor.requestAbort()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'closing-live',
      classification: 'pre-install',
      code: 'ABORT_REQUESTED',
      safeCode: 'BEFORE_CLOSE',
      liveDisposition: 'open'
    })
    expect(liveDb.closeForPromotion).not.toHaveBeenCalled()
    expect(installFake).not.toHaveBeenCalled()
    expect(sidecarsPresent()).toBe(true)
    await expectPreInstallUntouched()
    expectLeaseStillHeld()
  })

  it('C19: abort raced during close — stops before install, live reopened, bytes unchanged', async () => {
    const executor = makeExecutor()
    liveDb.closeForPromotion.mockImplementation((auth: PromotionLeaseHandle) => {
      const verdict = validatePromotionAuthorization(auth, coordinator)
      if (!verdict.authorized) throw new Error(`invalid (${verdict.reason})`)
      liveDb.state.open = false
      executor.requestAbort() // will-quit/dispose raced the destructive window
      return true
    })
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'installing',
      classification: 'pre-install',
      code: 'ABORT_REQUESTED',
      safeCode: 'BEFORE_INSTALL',
      liveDisposition: 'open'
    })
    expect(installFake).not.toHaveBeenCalled()
    expect(liveDb.reopenForPromotion).toHaveBeenCalledTimes(1)
    await expectPreInstallUntouched()
    expectLeaseStillHeld()
  })
})

// ---------------------------------------------------------------------------
// Post-install fault classes (C12–C17, C20) — recovery-required, LOCK-4425
// ---------------------------------------------------------------------------

describe('promotion executor — post-install faults (recovery-required)', () => {
  /** Shared post-install invariants: installed bytes retained, snapshot retained, no reopen-forward, lease held. */
  function expectPostInstallRetained(): void {
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true) // installed bytes NEVER rolled back
    expectRetainedUntouched() // snapshot retained, never restored
    expectLeaseStillHeld() // executor never releases the lease
  }

  it('C12: install post-install failure — artifacts retained, journal stays snapshot-ready, live closed', async () => {
    installFake.mockImplementation(() => {
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath) // the rename ALREADY happened
      return {
        ok: false as const,
        phase: 'post-install' as const,
        code: 'DESTINATION_IDENTITY_MISMATCH' as const,
        safeCode: 'STAT_IDENTITY_DIVERGED'
      }
    })
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'installing',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'INSTALL_FAILED',
      safeCode: 'DESTINATION_IDENTITY_MISMATCH:STAT_IDENTITY_DIVERGED',
      liveDisposition: 'closed'
    })
    // LOCK-4423: candidate-installed is NEVER journaled without durable success.
    expect(await journalPhase()).toBe('snapshot-ready')
    expect(liveDb.reopenForPromotion).not.toHaveBeenCalled()
    expect(verifyFake).not.toHaveBeenCalled()
    expectPostInstallRetained()
  })

  it('C13: candidate-installed journal advancement fails — recovery-required, durable journal preserved', async () => {
    const executor = makeExecutor({
      advanceCandidateInstalled: (async () => {
        const { PromotionJournalStoreError } = await import('../journalStore')
        throw new PromotionJournalStoreError('PUBLISH_RENAME_FAILED', 'injected publish failure')
      }) as PromotionExecutionPrimitives['advanceCandidateInstalled']
    })
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'journal-candidate-installed',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'JOURNAL_CANDIDATE_INSTALLED_FAILED',
      safeCode: 'PUBLISH_RENAME_FAILED',
      liveDisposition: 'closed'
    })
    expect(await journalPhase()).toBe('snapshot-ready') // prior durable journal never cleared (LOCK-4425)
    expect(liveDb.reopenForPromotion).not.toHaveBeenCalled()
    expect(verifyFake).not.toHaveBeenCalled()
    expectPostInstallRetained()
  })

  it('C14: capability turns stale after install — forward progress stops, artifacts retained', async () => {
    installFake.mockImplementation((options: { candidateId: string }) => {
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath)
      // The lease is released/stolen inside the destructive window.
      authorization.release()
      const receipt: InstallReceipt = {
        candidateId: options.candidateId,
        livePath,
        identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
        installedAtMs: 0
      }
      return { ok: true as const, receipt }
    })
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'journal-candidate-installed',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'CAPABILITY_STALE',
      safeCode: 'released',
      liveDisposition: 'closed'
    })
    expect(await journalPhase()).toBe('snapshot-ready')
    expect(liveDb.reopenForPromotion).not.toHaveBeenCalled()
    expect(liveBytes().equals(CANDIDATE_BYTES)).toBe(true)
    expectRetainedUntouched()
  })

  it('C15: authorized reopen fails — journal candidate-installed, live closed, no rollback', async () => {
    liveDb.reopenForPromotion.mockImplementation(async () => {
      throw new Error('reopen refused')
    })
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'reopening-live',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'LIVE_REOPEN_FAILED',
      liveDisposition: 'closed'
    })
    expect(await journalPhase()).toBe('candidate-installed')
    expect(verifyFake).not.toHaveBeenCalled()
    expectPostInstallRetained()
  })

  it('C16: replacement verification fails — replacement-verified never journaled, live re-closed with the same authorization', async () => {
    verifyFake.mockImplementation(() => ({
      ok: false as const,
      code: 'REPLACEMENT_INTEGRITY_FAILED' as const,
      safeCode: null
    }))
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'verifying-replacement',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'REPLACEMENT_VERIFICATION_FAILED',
      safeCode: 'REPLACEMENT_INTEGRITY_FAILED',
      liveDisposition: 'closed'
    })
    // LOCK-4424: replacement-verified only after successful verification.
    expect(await journalPhase()).toBe('candidate-installed')
    // Finalization closed the reopened live handle with the SAME lease.
    expect(liveDb.closeForPromotion).toHaveBeenCalledTimes(2)
    expect(liveDb.state.open).toBe(false)
    expectPostInstallRetained()
  })

  it('C17: replacement-verified journal advancement fails — verified bytes retained, recovery-required', async () => {
    const executor = makeExecutor({
      advanceReplacementVerified: (async () => {
        const { PromotionJournalStoreError } = await import('../journalStore')
        throw new PromotionJournalStoreError('PARENT_DIR_SYNC_FAILED', 'injected sync failure')
      }) as PromotionExecutionPrimitives['advanceReplacementVerified']
    })
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'journal-replacement-verified',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'JOURNAL_REPLACEMENT_VERIFIED_FAILED',
      safeCode: 'PARENT_DIR_SYNC_FAILED',
      liveDisposition: 'closed'
    })
    expect(await journalPhase()).toBe('candidate-installed')
    expectPostInstallRetained()
  })

  it('C20: abort after install stops all forward progress — no reopen, no verify, artifacts retained', async () => {
    const executor = makeExecutor()
    installFake.mockImplementation((options: { candidateId: string }) => {
      realFs.rmSync(`${livePath}-wal`, { force: true })
      realFs.rmSync(`${livePath}-shm`, { force: true })
      realFs.renameSync(candidatePath, livePath)
      executor.requestAbort() // will-quit/dispose raced after the rename
      const receipt: InstallReceipt = {
        candidateId: options.candidateId,
        livePath,
        identity: { dev: 1n, ino: 1n, size: BigInt(CANDIDATE_BYTES.length) },
        installedAtMs: 0
      }
      return { ok: true as const, receipt }
    })
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      subphase: 'journal-candidate-installed',
      classification: 'post-install',
      recoveryRequired: true,
      code: 'ABORT_REQUESTED',
      safeCode: 'BEFORE_JOURNAL_CANDIDATE_INSTALLED',
      liveDisposition: 'closed'
    })
    expect(await journalPhase()).toBe('snapshot-ready')
    expect(liveDb.reopenForPromotion).not.toHaveBeenCalled()
    expect(verifyFake).not.toHaveBeenCalled()
    expectPostInstallRetained()
  })

  it('unexpected primitive throw is contained — never rejects, classified by the install boundary', async () => {
    verifyFake.mockImplementation(() => {
      throw new Error('verifier exploded')
    })
    const executor = makeExecutor()
    const result = await executor.run()

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toMatchObject({
      classification: 'post-install',
      recoveryRequired: true,
      code: 'UNEXPECTED_FAILURE',
      liveDisposition: 'closed'
    })
    expect(await journalPhase()).toBe('candidate-installed')
    expectPostInstallRetained()
    expect(executor.isSettled()).toBe(true)
  })
})
