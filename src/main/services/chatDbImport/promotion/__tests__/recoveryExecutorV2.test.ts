/**
 * v2 recovery executor direct tests (LOCK-REC-1..LOCK-REC-8).
 *
 * Two layers:
 * 1. Mocked-primitive executor tests — every side-effect seam
 *    (probeV2/decide/readJournal/advance/cleanupAtPhase/rollbackAll/
 *    verifyInstalledGeneration/verifyPreApplyGeneration/markRepair + the
 *    catalog boundary + liveDb + restart) is injected, so every matrix
 *    action, ordering rule, failure injection, idempotent re-entry, and
 *    restart behavior is proven deterministically without touching disk.
 * 2. Real-FS verification-exactness tests — `verifyInstalledGeneration` /
 *    `verifyPreApplyGeneration` run against a REAL migrated chat.db
 *    (better-sqlite3), a REAL candidate catalog handoff, and a REAL Files
 *    dir, proving the all-new receipt verification is exact and tamper
 *    sensitive (LOCK-REC-2/4).
 *
 * Coverage anchors:
 * - LOCK-REC-1: the probe-derived `candidateCatalog` is fed to the matrix.
 * - LOCK-REC-2: pre-apply verification → apply (already-matching skip) →
 *   re-query verify → advance catalog-applied → advance replacement-verified
 *   → cleanup → restart; journal never overstates a completed side effect.
 * - LOCK-REC-3: restore failure leaves the journal (no cleanup/restart).
 * - LOCK-REC-4: accept reverifies all three before cleanup.
 * - LOCK-REC-5: keep-old-live validates pre-destructive phases only.
 * - LOCK-REC-6: side effects idempotent across re-entry.
 * - LOCK-REC-7: never rejects; fresh-main mode may return no restart;
 *   privacy-bounded failure codes only.
 */

import * as realCrypto from 'node:crypto'
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Real filesystem behavior (the setup mocks node:fs/os/path).
vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

// Never touch a live Data path; every call injects an explicit temp root.
vi.mock('@main/config', () => ({ DATA_PATH: '/mock/data' }))

import {
  acquirePromotionLease,
  resetSharedMaintenanceCoordinatorForTests
} from '@main/services/chatDb/maintenanceCoordination'
import { runMigrations } from '@main/services/chatDb/migration'
import * as schema from '@main/services/chatDb/schema'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import type { probePromotionArtifactsV2 } from '../artifactProbe'
import {
  computeCatalogReceipt,
  computeDbReceipt,
  computeFilesReceipt,
  type FilesReceiptEntry
} from '../artifactReceipts'
import type { PromotionArtifactReceipts } from '../journal'
import { PROMOTION_JOURNAL_VERSION_V2, type PromotionJournalPhaseV2, type PromotionJournalV2 } from '../journal'
import { decidePromotionRecoveryV2 } from '../recovery'
import {
  type RecoveryV2CatalogBoundary,
  type RecoveryV2LiveDb,
  type RecoveryV2Options,
  type RecoveryV2Result,
  runRecoveryV2,
  verifyInstalledGeneration,
  verifyPreApplyGeneration
} from '../recoveryExecutorV2'

// ---------------------------------------------------------------------------
// Shared test constants + factories (mocked-primitive layer)
// ---------------------------------------------------------------------------

const SESSION_ID = 'import-s1'
const CANDIDATE_ID = 'candidate-import-s1'

function sha(hex: string): string {
  return hex.repeat(64)
}

/** Mutate the journal phase (the codec type declares it readonly). */
function setPhase(journal: PromotionJournalV2, phase: PromotionJournalPhaseV2): void {
  ;(journal as { phase: PromotionJournalPhaseV2 }).phase = phase
}

function v2Journal(phase: PromotionJournalPhaseV2): PromotionJournalV2 {
  return {
    version: PROMOTION_JOURNAL_VERSION_V2,
    sessionId: SESSION_ID,
    candidateId: CANDIDATE_ID,
    phase,
    receipts: {
      candidate: {
        db: { sha256: sha('a'), size: 100 },
        files: { count: 1, totalBytes: 10, sha256: sha('b') },
        catalog: { count: 1, sha256: sha('c') }
      },
      old: {
        db: { sha256: sha('d'), size: 90 },
        files: { count: 0, totalBytes: 0, sha256: sha('e') },
        catalog: { count: 0, sha256: sha('f') }
      }
    }
  }
}

type ProbeV2Result = ReturnType<typeof probePromotionArtifactsV2>

function probeResult(journal: PromotionJournalV2, overrides: Partial<ProbeV2Result> = {}): ProbeV2Result {
  return {
    journal: { status: 'valid', journal },
    live: 'present-verified',
    dbSnapshot: 'present-verified',
    candidate: 'missing',
    files: 'present-verified',
    filesSnapshot: 'present-verified',
    filesStaging: 'missing',
    catalogSnapshot: 'present-verified',
    catalogApplied: 'unknown',
    candidateCatalog: 'present',
    ...overrides
  }
}

function fakeBoundary(overrides: Partial<RecoveryV2CatalogBoundary> = {}): RecoveryV2CatalogBoundary {
  return {
    applyCandidate: vi.fn(async () => ({ ok: true as const, facts: { count: 1, sha256: sha('c') } })),
    restoreSnapshot: vi.fn(async () => ({ ok: true as const, facts: { count: 0, sha256: sha('f') } })),
    queryFacts: vi.fn(async () => ({ ok: true as const, facts: { count: 1, sha256: sha('c') } })),
    ...overrides
  }
}

const fakeLiveDb: RecoveryV2LiveDb = { isInitialised: () => false }

interface Harness {
  diskJournal: PromotionJournalV2
  probeV2: ReturnType<typeof vi.fn>
  decide: ReturnType<typeof vi.fn>
  readJournal: ReturnType<typeof vi.fn>
  advance: ReturnType<typeof vi.fn>
  cleanupAtPhase: ReturnType<typeof vi.fn>
  rollbackAll: ReturnType<typeof vi.fn>
  markRepair: ReturnType<typeof vi.fn>
  verifyInstalled: ReturnType<typeof vi.fn>
  verifyPreApply: ReturnType<typeof vi.fn>
  readHandoff: ReturnType<typeof vi.fn>
  computeLiveDbReceiptMatch: ReturnType<typeof vi.fn>
  removeConvergedCandidate: ReturnType<typeof vi.fn>
  boundary: RecoveryV2CatalogBoundary
  order: string[]
  run: (overrides?: Partial<RecoveryV2Options>) => Promise<RecoveryV2Result>
}

function createHarness(phase: PromotionJournalPhaseV2): Harness {
  const diskJournal: PromotionJournalV2 = v2Journal(phase)
  const order: string[] = []

  const readJournal = vi.fn(async () => ({ status: 'valid' as const, journal: diskJournal }))
  const advance = vi.fn(async (doc: PromotionJournalV2, prior: PromotionJournalPhaseV2) => {
    order.push(`advance:${prior}->${doc.phase}`)
    setPhase(diskJournal, doc.phase)
  })
  const probeV2 = vi.fn(() => probeResult(diskJournal))
  const decide = vi.fn((input: unknown) => {
    order.push('decide')
    return decidePromotionRecoveryV2(input as Parameters<typeof decidePromotionRecoveryV2>[0])
  })
  const cleanupAtPhase = vi.fn(async (phase: PromotionJournalPhaseV2) => {
    order.push(`cleanup:${phase}`)
    return { deleted: true as const }
  })
  const rollbackAll = vi.fn(async () => {
    order.push('rollback-all')
    return { ok: true as const }
  })
  const markRepair = vi.fn(() => {
    order.push('mark-repair')
  })
  const verifyInstalled = vi.fn(async () => {
    order.push('verify-installed')
    return true
  })
  const verifyPreApply = vi.fn(async () => {
    order.push('verify-pre-apply')
    return true
  })
  const readHandoff = vi.fn(() => ({
    rows: [
      {
        id: 'file-1',
        name: 'file-1.txt',
        origin_name: 'file-1.txt',
        path: 'Files/file-1.txt',
        size: 10,
        ext: '.txt',
        type: null,
        created_at: null,
        count: 1
      } as const
    ],
    receipt: { count: 1, sha256: sha('c') }
  }))
  // LOCK-AMB-3 seam: the harness default treats the live DB as EXACTLY the
  // candidate (the normal forward state). Rollback-midway tests flip it to
  // false.
  const computeLiveDbReceiptMatch = vi.fn(async () => true)
  // LOCK-CLEAN seam: default successful exact candidate removal.
  const removeConvergedCandidate = vi.fn(async (candidateId: string) => {
    order.push(`remove-converged-candidate:${candidateId}`)
    return true
  })
  const boundary = fakeBoundary({
    applyCandidate: vi.fn(async (): Promise<{ ok: true; facts: { count: number; sha256: string } }> => {
      order.push('apply-candidate')
      return { ok: true, facts: { count: 1, sha256: sha('c') } }
    })
  })

  const primitives: NonNullable<RecoveryV2Options['primitives']> = {
    probeV2,
    decide,
    readJournal,
    advance,
    cleanupAtPhase,
    rollbackAll,
    markRepairRequiredBeforeInit: markRepair,
    verifyInstalledGeneration: verifyInstalled,
    verifyPreApplyGeneration: verifyPreApply,
    readHandoff,
    computeLiveDbReceiptMatch,
    removeConvergedCandidate
  }

  const baseOptions: RecoveryV2Options = {
    dataRoot: '/test/data',
    catalogBoundary: boundary,
    liveDb: fakeLiveDb,
    restart: {
      mode: 'in-process-reload',
      relaunch: () => ({ relaunched: false }),
      reloadRenderer: () => ({ ok: true, reloaded: true })
    },
    primitives
  }

  return {
    diskJournal,
    probeV2,
    decide,
    readJournal,
    advance,
    cleanupAtPhase,
    rollbackAll,
    markRepair,
    verifyInstalled,
    verifyPreApply,
    readHandoff,
    computeLiveDbReceiptMatch,
    removeConvergedCandidate,
    boundary,
    order,
    run: async (overrides: Partial<RecoveryV2Options> = {}) => runRecoveryV2({ ...baseOptions, ...overrides })
  }
}

function expectOk(result: RecoveryV2Result) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('unreachable: expected ok')
  return result
}

function expectFail(result: RecoveryV2Result, code: string, safeCode?: string) {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable: expected failure')
  expect(result.code).toBe(code)
  if (safeCode !== undefined) expect(result.safeCode).toBe(safeCode)
}

/** Force `catalogApplied` to 'unverified' so the executor actually applies. */
function forceCatalogApply(h: Harness): void {
  h.boundary.queryFacts = vi.fn(async () => ({ ok: true as const, facts: { count: 0, sha256: sha('0') } }))
}

/** Force the pure matrix to decide restore-rollback-snapshot at this phase. */
function forceRestoreDecision(h: Harness): void {
  h.probeV2.mockReturnValue(
    probeResult(h.diskJournal, {
      live: 'present-unverified',
      candidate: 'missing',
      files: 'present-unverified',
      filesStaging: 'present',
      candidateCatalog: 'missing'
    })
  )
}

// ---------------------------------------------------------------------------
// Mocked-primitive executor tests
// ---------------------------------------------------------------------------

describe('runRecoveryV2 (mocked primitives)', () => {
  beforeEach(() => {
    resetSharedMaintenanceCoordinatorForTests()
  })

  describe('journal read / probe / decide failures', () => {
    it('maps an invalid journal to JOURNAL_NOT_V2 INVALID (never rejected)', async () => {
      const h = createHarness('catalog-pending')
      h.readJournal.mockResolvedValueOnce({ status: 'invalid', code: 'NOT_JSON' })
      expectFail(await h.run(), 'JOURNAL_NOT_V2', 'INVALID')
    })

    it('maps an absent journal to JOURNAL_NOT_V2 ABSENT', async () => {
      const h = createHarness('catalog-pending')
      h.readJournal.mockResolvedValueOnce({ status: 'absent' })
      expectFail(await h.run(), 'JOURNAL_NOT_V2', 'ABSENT')
    })

    it('maps a v1 journal to JOURNAL_NOT_V2 V1 (LOCK-PROMO-10 never reinterpreted)', async () => {
      const h = createHarness('catalog-pending')
      h.readJournal.mockResolvedValueOnce({
        status: 'valid',
        journal: { version: 1, sessionId: SESSION_ID, candidateId: CANDIDATE_ID, phase: 'candidate-installed' }
      })
      expectFail(await h.run(), 'JOURNAL_NOT_V2', 'V1')
    })

    it('maps a throwing journal read to JOURNAL_READ_FAILED', async () => {
      const h = createHarness('catalog-pending')
      h.readJournal.mockRejectedValueOnce(new Error('io'))
      expectFail(await h.run(), 'JOURNAL_READ_FAILED', 'IO')
    })

    it('maps a throwing probe to PROBE_FAILED', async () => {
      const h = createHarness('catalog-pending')
      h.probeV2.mockImplementation(() => {
        throw new Error('probe exploded')
      })
      expectFail(await h.run(), 'PROBE_FAILED', 'IO')
    })

    it('maps a throwing decide to DECIDE_FAILED', async () => {
      const h = createHarness('catalog-pending')
      h.decide.mockImplementation(() => {
        throw new Error('decide exploded')
      })
      expectFail(await h.run(), 'DECIDE_FAILED', 'IO')
    })

    it('never rejects even when an injected primitive throws unexpectedly (LOCK-REC-7)', async () => {
      const h = createHarness('catalog-pending')
      h.probeV2.mockImplementation(() => {
        throw new Error('unexpected')
      })
      const result = await h.run()
      expect(result.ok).toBe(false)
    })
  })

  describe('LOCK-REC-1 — probe-derived candidateCatalog feeds the matrix', () => {
    it('forwards candidateCatalog=present unchanged into the decision input', async () => {
      const h = createHarness('files-installed')
      h.decide.mockImplementation((input) => {
        expect((input as { candidateCatalog?: 'missing' | 'present' }).candidateCatalog).toBe('present')
        return { action: 'complete-catalog-apply', reason: 'FILES_INSTALLED_FORWARD_VERIFIABLE' }
      })
      h.verifyPreApply.mockReturnValue(true)
      h.verifyInstalled.mockResolvedValue(true)
      const result = await h.run()
      expectOk(result)
    })

    it('a missing candidateCatalog handoff blocks forward completion (matrix falls to restore)', async () => {
      // files-installed, candidate db consumed, handoff missing → the wired
      // candidateCatalog=m'issing' makes the pure matrix choose restore.
      const h = createHarness('files-installed')
      h.probeV2.mockReturnValue(
        probeResult(h.diskJournal, {
          candidate: 'missing',
          candidateCatalog: 'missing',
          live: 'present-verified',
          files: 'present-verified',
          filesSnapshot: 'present-verified',
          dbSnapshot: 'present-verified',
          catalogSnapshot: 'present-verified'
        })
      )
      const result = await h.run()
      expectOk(result)
      if (!result.ok) return
      expect(result.action).toBe('restore-rollback-snapshot')
      expect(h.rollbackAll).toHaveBeenCalledTimes(1)
    })
  })

  describe('action: keep-old-live (LOCK-REC-5)', () => {
    it('an absent journal is JOURNAL_NOT_V2 ABSENT — the executor only runs v2 recovery on a valid v2 journal (the gate owns the NO_JOURNAL fast path)', async () => {
      const h = createHarness('candidates-ready')
      h.readJournal.mockResolvedValueOnce({ status: 'absent' })
      expectFail(await h.run(), 'JOURNAL_NOT_V2', 'ABSENT')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('candidates-ready valid journal → cleanup at candidates-ready, journalCleaned=true', async () => {
      const h = createHarness('candidates-ready')
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('keep-old-live')
      expect(ok.journalCleaned).toBe(true)
      expect(h.cleanupAtPhase).toHaveBeenCalledWith(
        'candidates-ready',
        { sessionId: SESSION_ID, candidateId: CANDIDATE_ID },
        '/test/data'
      )
    })

    it('snapshots-ready with the old generation intact → cleanup at snapshots-ready', async () => {
      const h = createHarness('snapshots-ready')
      h.probeV2.mockReturnValue(probeResult(h.diskJournal, { candidate: 'present' }))
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('keep-old-live')
      expect(h.cleanupAtPhase).toHaveBeenCalledWith('snapshots-ready', expect.anything(), '/test/data')
    })

    it('snapshots-ready with a consumed candidate → fail closed, journal retained (no cleanup)', async () => {
      const h = createHarness('snapshots-ready')
      h.probeV2.mockReturnValue(probeResult(h.diskJournal, { candidate: 'missing' }))
      // The real matrix would restore here; force the executor to see a
      // keep-old decision over an ambiguous state defensively.
      h.decide.mockReturnValue({ action: 'keep-old-live', reason: 'SNAPSHOTS_READY_LIVE_INTACT' })
      expectFail(await h.run(), 'CLEANUP_FAILED', 'KEEP_OLD_CANDIDATE_CONSUMED')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('keep-old-live over a destructive-phase journal → fail closed, no cleanup', async () => {
      const h = createHarness('db-installed')
      h.decide.mockReturnValue({ action: 'keep-old-live', reason: 'TEST' })
      expectFail(await h.run(), 'CLEANUP_FAILED', 'KEEP_OLD_UNEXPECTED_PHASE')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('cleanup failure → CLEANUP_FAILED, no success signal', async () => {
      const h = createHarness('candidates-ready')
      h.cleanupAtPhase.mockRejectedValueOnce(new Error('io'))
      expectFail(await h.run(), 'CLEANUP_FAILED', 'IO')
    })
  })

  describe('candidate evidence cleanup after convergence (LOCK-CLEAN-1..5)', () => {
    it('keep-old-live removes the exact candidate evidence after the journal cleanup', async () => {
      const h = createHarness('candidates-ready')
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('keep-old-live')
      expect(ok.journalCleaned).toBe(true)
      expect(ok.candidateCleaned).toBe(true)
      expect(h.removeConvergedCandidate).toHaveBeenCalledTimes(1)
      expect(h.removeConvergedCandidate).toHaveBeenCalledWith(CANDIDATE_ID, '/test/data')
      // Ordering: journal cleanup first, candidate removal second (LOCK-CLEAN-1).
      expect(h.order).toEqual(['decide', 'cleanup:candidates-ready', 'remove-converged-candidate:candidate-import-s1'])
    })

    it('LOCK-CLEAN-1: a journal cleanup failure keeps the candidate evidence intact (removal never attempted)', async () => {
      const h = createHarness('candidates-ready')
      h.cleanupAtPhase.mockRejectedValueOnce(new Error('io'))
      expectFail(await h.run(), 'CLEANUP_FAILED', 'IO')
      expect(h.removeConvergedCandidate).not.toHaveBeenCalled()
    })

    it('complete-catalog-apply removes the candidate evidence after the journal cleanup, before restart', async () => {
      const h = createHarness('files-installed')
      forceCatalogApply(h)
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('complete-catalog-apply')
      expect(ok.journalCleaned).toBe(true)
      expect(ok.candidateCleaned).toBe(true)
      expect(ok.restartRequested).toBe(true)
      expect(h.removeConvergedCandidate).toHaveBeenCalledTimes(1)
      expect(h.removeConvergedCandidate).toHaveBeenCalledWith(CANDIDATE_ID, '/test/data')
      // The exact final ordering: ...cleanup → remove → restart.
      expect(h.order).toEqual([
        'decide',
        'verify-pre-apply',
        'advance:files-installed->catalog-pending',
        'apply-candidate',
        'verify-installed',
        'advance:catalog-pending->catalog-applied',
        'advance:catalog-applied->replacement-verified',
        'cleanup:replacement-verified',
        'remove-converged-candidate:candidate-import-s1'
      ])
    })

    it('accept-verified-replacement removes the candidate evidence after reverification + journal cleanup', async () => {
      const h = createHarness('replacement-verified')
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('accept-verified-replacement')
      expect(ok.journalCleaned).toBe(true)
      expect(ok.candidateCleaned).toBe(true)
      expect(h.removeConvergedCandidate).toHaveBeenCalledWith(CANDIDATE_ID, '/test/data')
    })

    it('restore-rollback-snapshot removes the candidate evidence after all-old rollback + journal cleanup', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('restore-rollback-snapshot')
      expect(ok.journalCleaned).toBe(true)
      expect(ok.candidateCleaned).toBe(true)
      expect(h.rollbackAll).toHaveBeenCalledTimes(1)
      expect(h.removeConvergedCandidate).toHaveBeenCalledWith(CANDIDATE_ID, '/test/data')
      expect(h.order).toContain('remove-converged-candidate:candidate-import-s1')
    })

    it('LOCK-CLEAN-4: a candidate removal failure is a residual — convergence stays ok, restart proceeds, candidateCleaned=false', async () => {
      const h = createHarness('replacement-verified')
      h.removeConvergedCandidate.mockRejectedValueOnce(new Error('io'))
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('accept-verified-replacement')
      expect(ok.journalCleaned).toBe(true)
      expect(ok.candidateCleaned).toBe(false)
      expect(ok.restartRequested).toBe(true)
      // The journal is gone; the residual is left for age-based orphan cleanup.
      expect(h.cleanupAtPhase).toHaveBeenCalledWith('replacement-verified', expect.anything(), '/test/data')
    })

    it('keep-old-live removal failure is a residual too — keep-old still converges truthfully', async () => {
      const h = createHarness('candidates-ready')
      h.removeConvergedCandidate.mockRejectedValueOnce(new Error('io'))
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('keep-old-live')
      expect(ok.journalCleaned).toBe(true)
      expect(ok.candidateCleaned).toBe(false)
      expect(ok.restartRequested).toBe(false)
    })

    it('idempotent: the executor reports candidateCleaned=true when the removal already-absent returns true', async () => {
      const h = createHarness('replacement-verified')
      h.removeConvergedCandidate.mockResolvedValueOnce(true)
      const first = await h.run()
      expectOk(first)
      h.removeConvergedCandidate.mockResolvedValueOnce(true)
      const second = await h.run()
      const ok = expectOk(second)
      expect(ok.candidateCleaned).toBe(true)
      expect(h.removeConvergedCandidate).toHaveBeenCalledTimes(2)
      expect(h.removeConvergedCandidate).toHaveBeenNthCalledWith(1, CANDIDATE_ID, '/test/data')
      expect(h.removeConvergedCandidate).toHaveBeenNthCalledWith(2, CANDIDATE_ID, '/test/data')
    })

    it('repair-required never removes candidate evidence (no journal cleanup happened)', async () => {
      const h = createHarness('catalog-pending')
      h.decide.mockReturnValue({ action: 'repair-required', reason: 'JOURNAL_INVALID' })
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.candidateCleaned).toBe(false)
      expect(h.removeConvergedCandidate).not.toHaveBeenCalled()
    })

    it('deferred-to-window paths never remove candidate evidence (LOCK-CLEAN-5: journal still exists)', async () => {
      const h = createHarness('catalog-pending')
      const result = await h.run({ catalogBoundary: null })
      const ok = expectOk(result)
      expect(ok.deferredToWindow).toBe(true)
      expect(ok.journalCleaned).toBe(false)
      expect(ok.candidateCleaned).toBe(false)
      expect(h.removeConvergedCandidate).not.toHaveBeenCalled()
    })

    it('F1 deferred-to-startup leaves the candidate evidence intact (journal retained)', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      const busy = acquirePromotionLease('busy-holder')
      try {
        const result = await h.run()
        const ok = expectOk(result)
        expect(ok.deferredToStartup).toBe(true)
        if (ok.deferredToStartup !== true) throw new Error('expected deferred-to-startup result')
        expect(ok.candidateCleaned).toBe(false)
        expect(h.removeConvergedCandidate).not.toHaveBeenCalled()
      } finally {
        busy.release()
      }
    })
  })

  describe('action: repair-required', () => {
    it('marks repair, no cleanup, no restart', async () => {
      const h = createHarness('catalog-pending')
      h.decide.mockReturnValue({ action: 'repair-required', reason: 'JOURNAL_INVALID' })
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('repair-required')
      expect(ok.journalCleaned).toBe(false)
      expect(h.markRepair).toHaveBeenCalledTimes(1)
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('mark failure → REPAIR_MARK_FAILED', async () => {
      const h = createHarness('catalog-pending')
      h.decide.mockReturnValue({ action: 'repair-required', reason: 'JOURNAL_INVALID' })
      h.markRepair.mockImplementation(() => {
        throw new Error('marker write failed')
      })
      expectFail(await h.run(), 'REPAIR_MARK_FAILED', 'IO')
    })
  })

  describe('action: complete-catalog-apply (LOCK-REC-2 ordering)', () => {
    it('executes the full ordering: pre-verify → apply → re-verify → advance → advance → cleanup → remove candidate → restart', async () => {
      const h = createHarness('files-installed')
      forceCatalogApply(h)
      const result = await h.run()
      expectOk(result)
      expect(h.order).toEqual([
        'decide',
        'verify-pre-apply',
        'advance:files-installed->catalog-pending',
        'apply-candidate',
        'verify-installed',
        'advance:catalog-pending->catalog-applied',
        'advance:catalog-applied->replacement-verified',
        'cleanup:replacement-verified',
        'remove-converged-candidate:candidate-import-s1'
      ])
    })

    it('skips the catalog mutation when the live catalog already matches (already-matching skip)', async () => {
      const h = createHarness('catalog-pending')
      // queryFacts matches the candidate receipt → catalogApplied=verified.
      const result = await h.run()
      expectOk(result)
      expect(h.boundary.applyCandidate).not.toHaveBeenCalled()
      expect(h.order).toContain('advance:catalog-pending->catalog-applied')
      expect(h.order).toContain('advance:catalog-applied->replacement-verified')
      expect(h.order).toContain('cleanup:replacement-verified')
    })

    it('a pre-apply verification failure fails closed BEFORE any journal advance or mutation', async () => {
      const h = createHarness('files-installed')
      h.verifyPreApply.mockReturnValueOnce(false)
      expectFail(await h.run(), 'VERIFY_FAILED', 'PRE_APPLY_GENERATION')
      expect(h.advance).not.toHaveBeenCalled()
      expect(h.boundary.applyCandidate).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('a re-query mismatch (verify-installed false) never journals catalog-applied', async () => {
      const h = createHarness('catalog-pending')
      h.verifyInstalled.mockResolvedValueOnce(false)
      expectFail(await h.run(), 'VERIFY_FAILED', 'INSTALLED_GENERATION')
      const advancedTo = h.advance.mock.calls.map((c) => (c[0] as PromotionJournalV2).phase)
      expect(advancedTo).not.toContain('catalog-applied')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('transaction failure → CATALOG_APPLY_FAILED with the bounded boundary code', async () => {
      const h = createHarness('catalog-pending')
      forceCatalogApply(h)
      h.boundary.applyCandidate = vi.fn(async () => ({ ok: false as const, code: 'RENDERER_FAILED' }))
      expectFail(await h.run(), 'CATALOG_APPLY_FAILED', 'RENDERER_FAILED')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('boundary throw → CATALOG_APPLY_FAILED BOUNDARY_THREW', async () => {
      const h = createHarness('catalog-pending')
      forceCatalogApply(h)
      h.boundary.applyCandidate = vi.fn(async () => {
        throw new Error('boundary exploded')
      })
      expectFail(await h.run(), 'CATALOG_APPLY_FAILED', 'BOUNDARY_THREW')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('journal advance failure at each transition leaves the journal and returns the bounded code', async () => {
      const h1 = createHarness('files-installed')
      forceCatalogApply(h1)
      h1.advance.mockRejectedValueOnce(new Error('io'))
      expectFail(await h1.run(), 'JOURNAL_ADVANCE_FAILED', 'CATALOG_PENDING')

      const h2 = createHarness('catalog-pending')
      forceCatalogApply(h2)
      h2.advance.mockRejectedValueOnce(new Error('io'))
      expectFail(await h2.run(), 'JOURNAL_ADVANCE_FAILED', 'CATALOG_APPLIED')

      const h3 = createHarness('catalog-pending')
      forceCatalogApply(h3)
      let advanceCount = 0
      h3.advance.mockImplementation(async (doc: PromotionJournalV2) => {
        advanceCount++
        if (advanceCount === 2) throw new Error('io')
        setPhase(h3.diskJournal, doc.phase)
      })
      expectFail(await h3.run(), 'JOURNAL_ADVANCE_FAILED', 'REPLACEMENT_VERIFIED')
      // The catalog-applied transition completed but replacement-verified did
      // not — the journal stays at catalog-applied (no overstatement).
      expect(h3.diskJournal.phase).toBe('catalog-applied')
    })

    it('cleanup failure after full verification → CLEANUP_FAILED, restart never requested', async () => {
      const h = createHarness('catalog-pending')
      h.cleanupAtPhase.mockRejectedValueOnce(new Error('io'))
      expectFail(await h.run(), 'CLEANUP_FAILED', 'IO')
    })

    it('retry after a crash between apply and advance is idempotent (apply skipped, converges)', async () => {
      // Simulate the durable state after a crash right after the apply:
      // journal still catalog-pending, catalog already matches.
      const h = createHarness('catalog-pending')
      const result = await h.run()
      expectOk(result)
      // The already-matching skip means the second run applies nothing.
      expect(h.boundary.applyCandidate).not.toHaveBeenCalled()
    })

    it('deferred to window mode when the catalog boundary is unavailable', async () => {
      const h = createHarness('catalog-pending')
      const result = await h.run({ catalogBoundary: null })
      const ok = expectOk(result)
      expect(ok.deferredToWindow).toBe(true)
      expect(ok.journalCleaned).toBe(false)
      expect(h.advance).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })
  })

  describe('action: accept-verified-replacement (LOCK-REC-4)', () => {
    it('reverifies all three then cleans up + restarts', async () => {
      const h = createHarness('replacement-verified')
      const result = await h.run()
      expectOk(result)
      expect(h.verifyInstalled).toHaveBeenCalledTimes(1)
      expect(h.order).toContain('verify-installed')
      expect(h.order).toContain('cleanup:replacement-verified')
    })

    it('never cleans up or restarts when reverification fails (phase alone is not trusted)', async () => {
      const h = createHarness('replacement-verified')
      h.verifyInstalled.mockResolvedValueOnce(false)
      expectFail(await h.run(), 'VERIFY_FAILED', 'INSTALLED_GENERATION')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('deferred to window mode when the catalog boundary is unavailable', async () => {
      const h = createHarness('replacement-verified')
      const result = await h.run({ catalogBoundary: null })
      const ok = expectOk(result)
      expect(ok.deferredToWindow).toBe(true)
      expect(h.verifyInstalled).not.toHaveBeenCalled()
    })
  })

  describe('action: restore-rollback-snapshot (LOCK-REC-3)', () => {
    it('closes the live DB, mints a proof, rolls back all three, then cleans up + restarts', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      let liveInitialised = true
      const liveDb = {
        isInitialised: () => liveInitialised,
        closeForPromotion: vi.fn(() => {
          liveInitialised = false
          return true
        })
      }
      const result = await h.run({ liveDb })
      expectOk(result)
      expect(liveDb.closeForPromotion).toHaveBeenCalledTimes(1)
      expect(h.rollbackAll).toHaveBeenCalledTimes(1)
      const rollbackArgs = h.rollbackAll.mock.calls[0][0] as {
        proof: unknown
        dataRoot: string
        catalogBoundary: unknown
        expectedOld: PromotionArtifactReceipts
        sampleCount?: number
      }
      expect(rollbackArgs.proof).toBeDefined()
      expect(rollbackArgs.dataRoot).toBe('/test/data')
      expect(rollbackArgs.expectedOld).toEqual(v2Journal('catalog-pending').receipts.old)
      expect(h.order).toContain('rollback-all')
      expect(h.order).toContain('cleanup:catalog-pending')
    })

    it('rollback failure → RESTORE_FAILED, journal retained (no cleanup/restart, no success signal)', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      h.rollbackAll.mockResolvedValueOnce({
        ok: false as const,
        code: 'CATALOG_FACTS_MISMATCH',
        safeCode: 'RECEIPT_DIVERGED'
      })
      expectFail(await h.run(), 'RESTORE_FAILED', 'CATALOG_FACTS_MISMATCH')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('F1: a busy promotion lease during restore defers to startup — not RESTORE_FAILED, never a rejection', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      // Occupy the promotion slot so acquirePromotionLease throws
      // MaintenanceBusyError (the terminal-handoff finalization context).
      const busy = acquirePromotionLease('busy-holder')
      try {
        const result = await h.run()
        // F1 contract: defer-to-startup, not restore success, not a generic
        // failure — journal retained, no rollback, no restart.
        const ok = expectOk(result)
        expect(ok.action).toBe('restore-rollback-snapshot')
        expect(ok.deferredToStartup).toBe(true)
        // Narrow to the deferred-to-startup variant before reading deferReason.
        if (ok.deferredToStartup !== true) throw new Error('expected deferred-to-startup result')
        expect(ok.deferReason).toBe('LEASE_BUSY')
        expect(ok.journalCleaned).toBe(false)
        expect(ok.restartRequested).toBe(false)
        expect(ok.deferredToWindow).toBe(false)
      } finally {
        busy.release()
      }
      expect(h.rollbackAll).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('F1: query timeout at replacement-verified while the terminal lease is held defers to startup (journal retained, no rollback, no restart)', async () => {
      const h = createHarness('replacement-verified')
      // Transient catalog query failure at replacement-verified (timeout):
      // the step-3 facts query throws → catalogApplied stays 'unknown' →
      // the pure matrix (snapshots verified, catalog not verified) decides
      // restore-rollback-snapshot.
      h.boundary.queryFacts = vi.fn(async () => {
        throw new Error('catalog query timed out')
      })
      // Terminal promotion ownership still holds the lease — the restore
      // cannot run in this process.
      const busy = acquirePromotionLease('terminal-handoff')
      try {
        const result = await h.run()
        const ok = expectOk(result)
        expect(ok.action).toBe('restore-rollback-snapshot')
        expect(ok.deferredToStartup).toBe(true)
        // Narrow to the deferred-to-startup variant before reading deferReason.
        if (ok.deferredToStartup !== true) throw new Error('expected deferred-to-startup result')
        expect(ok.deferReason).toBe('LEASE_BUSY')
        // Journal retained — no cleanup, no rollback, no duplicate restart.
        expect(ok.journalCleaned).toBe(false)
        expect(ok.restartRequested).toBe(false)
        expect(ok.deferredToWindow).toBe(false)
      } finally {
        busy.release()
      }
      expect(h.rollbackAll).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('F1: startup retry with a free lease accepts and cleans the retained replacement-verified journal', async () => {
      const h = createHarness('replacement-verified')
      // First (terminal finalization): query timeout + lease held → defer.
      h.boundary.queryFacts = vi.fn(async () => {
        throw new Error('catalog query timed out')
      })
      const busy = acquirePromotionLease('terminal-handoff')
      let first: RecoveryV2Result
      try {
        first = await h.run()
      } finally {
        busy.release()
      }
      const deferred = expectOk(first)
      expect(deferred.deferredToStartup).toBe(true)
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()

      // Startup retry (fresh process): boundary healthy + free lease → the
      // SAME retained replacement-verified journal is re-verified all-new,
      // accepted, and cleaned.
      h.boundary.queryFacts = vi.fn(async () => ({ ok: true as const, facts: { count: 1, sha256: sha('c') } }))
      const second = await h.run()
      const ok = expectOk(second)
      expect(ok.action).toBe('accept-verified-replacement')
      expect(ok.deferredToStartup).not.toBe(true)
      expect(ok.journalCleaned).toBe(true)
      expect(h.rollbackAll).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).toHaveBeenCalledWith('replacement-verified', expect.anything(), '/test/data')
    })

    it('closeForPromotion throw → bounded RESTORE_FAILED, lease released', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      const liveDb = {
        isInitialised: () => true,
        closeForPromotion: () => {
          throw new Error('close exploded')
        }
      }
      expectFail(await h.run({ liveDb }), 'RESTORE_FAILED', 'IO')
      expect(h.rollbackAll).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('live-not-closed proof refusal → RESTORE_FAILED LIVE_NOT_CLOSED', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      const liveDb = { isInitialised: () => true }
      expectFail(await h.run({ liveDb }), 'RESTORE_FAILED', 'LIVE_NOT_CLOSED')
      expect(h.cleanupAtPhase).not.toHaveBeenCalled()
    })

    it('deferred to window mode when the catalog boundary is unavailable', async () => {
      const h = createHarness('catalog-pending')
      forceRestoreDecision(h)
      const result = await h.run({ catalogBoundary: null })
      const ok = expectOk(result)
      expect(ok.deferredToWindow).toBe(true)
      expect(h.rollbackAll).not.toHaveBeenCalled()
    })
  })

  describe('rollback-midway crash convergence (LOCK-AMB-3/4, R1-R8)', () => {
    /**
     * R1/R3/R5/R7 — crash after the retained OLD db was restored, before the
     * OLD Files/catalog restore. Live DB = OLD (probe present-verified but
     * NOT the candidate receipt), live Files = NEW, live catalog = NEW.
     */
    function dbRestoreOnlyState(h: Harness): void {
      h.computeLiveDbReceiptMatch.mockResolvedValue(false)
      h.probeV2.mockReturnValue(
        probeResult(h.diskJournal, {
          live: 'present-verified',
          candidate: 'missing',
          files: 'present-verified',
          filesStaging: 'missing',
          candidateCatalog: 'present',
          dbSnapshot: 'present-verified',
          filesSnapshot: 'present-verified',
          catalogSnapshot: 'present-verified'
        })
      )
    }

    /**
     * R2/R4/R6/R8 — crash after the OLD db AND OLD Files were restored,
     * before the OLD catalog restore. Live DB = OLD, live Files = OLD (fails
     * candidate parity → present-unverified), live catalog = NEW.
     */
    function dbAndFilesRestoreState(h: Harness): void {
      h.computeLiveDbReceiptMatch.mockResolvedValue(false)
      h.probeV2.mockReturnValue(
        probeResult(h.diskJournal, {
          live: 'present-verified',
          candidate: 'missing',
          files: 'present-unverified',
          filesStaging: 'missing',
          candidateCatalog: 'present',
          dbSnapshot: 'present-verified',
          filesSnapshot: 'present-verified',
          catalogSnapshot: 'present-verified'
        })
      )
    }

    const CASES: Array<{ id: string; phase: PromotionJournalPhaseV2; dbRestoreOnly: boolean }> = [
      { id: 'R1', phase: 'files-installed', dbRestoreOnly: true },
      { id: 'R2', phase: 'files-installed', dbRestoreOnly: false },
      { id: 'R3', phase: 'catalog-pending', dbRestoreOnly: true },
      { id: 'R4', phase: 'catalog-pending', dbRestoreOnly: false },
      { id: 'R5', phase: 'catalog-applied', dbRestoreOnly: true },
      { id: 'R6', phase: 'catalog-applied', dbRestoreOnly: false },
      { id: 'R7', phase: 'replacement-verified', dbRestoreOnly: true },
      { id: 'R8', phase: 'replacement-verified', dbRestoreOnly: false }
    ]

    it.each(CASES)(
      '$id ($phase, dbRestoreOnly=$dbRestoreOnly) converges all-old: restore → rollbackAll → cleanup at the crashed phase',
      async ({ phase, dbRestoreOnly }) => {
        const h = createHarness(phase)
        if (dbRestoreOnly) dbRestoreOnlyState(h)
        else dbAndFilesRestoreState(h)
        const result = await h.run()
        const ok = expectOk(result)
        expect(ok.action).toBe('restore-rollback-snapshot')
        expect(ok.journalCleaned).toBe(true)
        expect(ok.restartRequested).toBe(true)
        expect(h.rollbackAll).toHaveBeenCalledTimes(1)
        expect(h.cleanupAtPhase).toHaveBeenCalledWith(phase, expect.anything(), '/test/data')
        // Never forward or accept the mixed state (LOCK-AMB-1).
        expect(h.advance).not.toHaveBeenCalled()
        expect(h.boundary.applyCandidate).not.toHaveBeenCalled()
      }
    )

    it('direct retry: R1 run twice (crash state → post-rollback state) converges deterministically — never loops, never forwards', async () => {
      const h = createHarness('files-installed')
      // First boot: R1 crash state (OLD db restored, NEW Files/catalog live).
      dbRestoreOnlyState(h)
      const first = await h.run()
      const ok1 = expectOk(first)
      expect(ok1.action).toBe('restore-rollback-snapshot')
      expect(h.rollbackAll).toHaveBeenCalledTimes(1)
      expect(h.cleanupAtPhase).toHaveBeenCalledWith('files-installed', expect.anything(), '/test/data')

      // Retry boot: the rollback finished DB+Files but the crash hit before
      // journal cleanup — OLD db + OLD Files + NEW catalog still journaled at
      // files-installed. The matrix must converge all-old again (idempotent).
      dbAndFilesRestoreState(h)
      const second = await h.run()
      const ok2 = expectOk(second)
      expect(ok2.action).toBe('restore-rollback-snapshot')
      expect(h.rollbackAll).toHaveBeenCalledTimes(2)
      expect(h.cleanupAtPhase).toHaveBeenCalledTimes(2)
      expect(ok2.journalCleaned).toBe(true)
      // Deterministic convergence: identical inputs ⇒ identical restore action.
      expect(second).toEqual(
        expect.objectContaining({ ok: true, action: 'restore-rollback-snapshot', journalCleaned: true })
      )
    })

    it('R5: a DB-restored crash at catalog-applied is NEVER accepted — even with catalogApplied=verified and Files verified', async () => {
      const h = createHarness('catalog-applied')
      dbRestoreOnlyState(h)
      // The boundary default returns facts matching the CANDIDATE catalog →
      // catalogApplied=verified; every accept precondition holds EXCEPT the
      // exact candidate db identity.
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('restore-rollback-snapshot')
      expect(h.verifyInstalled).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).toHaveBeenCalledWith('catalog-applied', expect.anything(), '/test/data')
    })

    it('R7: a DB-restored crash at replacement-verified is NEVER accepted', async () => {
      const h = createHarness('replacement-verified')
      dbRestoreOnlyState(h)
      const result = await h.run()
      const ok = expectOk(result)
      expect(ok.action).toBe('restore-rollback-snapshot')
      expect(h.verifyInstalled).not.toHaveBeenCalled()
      expect(h.cleanupAtPhase).toHaveBeenCalledWith('replacement-verified', expect.anything(), '/test/data')
    })

    it('feeds the computed receipt identity into the matrix input (probe-derived field reaches decide)', async () => {
      const h = createHarness('files-installed')
      h.computeLiveDbReceiptMatch.mockResolvedValue(true)
      h.decide.mockImplementation((input) => {
        expect((input as { liveDbReceiptMatchesCandidate?: boolean }).liveDbReceiptMatchesCandidate).toBe(true)
        return { action: 'complete-catalog-apply', reason: 'FILES_INSTALLED_FORWARD_VERIFIABLE' }
      })
      h.verifyPreApply.mockResolvedValue(true)
      h.verifyInstalled.mockResolvedValue(true)
      const result = await h.run()
      expectOk(result)
    })

    it('the real default computation fails closed (false) when the live DB is unreadable/missing', async () => {
      const h = createHarness('files-installed')
      // Omit the seam so the REAL default disk computation runs against the
      // harness dataRoot (no real chat.db file → computeDbReceipt throws).
      const result = await h.run({
        primitives: {
          probeV2: h.probeV2,
          decide: h.decide,
          readJournal: h.readJournal,
          advance: h.advance,
          cleanupAtPhase: h.cleanupAtPhase,
          rollbackAll: h.rollbackAll,
          markRepairRequiredBeforeInit: h.markRepair,
          verifyInstalledGeneration: h.verifyInstalled,
          verifyPreApplyGeneration: h.verifyPreApply,
          readHandoff: h.readHandoff
        }
      })
      const ok = expectOk(result)
      // files-installed + live verified + files verified + handoff present but
      // the real receipt match is false → the mixed/OLD db must never forward.
      expect(ok.action).toBe('restore-rollback-snapshot')
      expect(h.advance).not.toHaveBeenCalled()
    })
  })

  describe('restart behavior (LOCK-REC-7)', () => {
    function restartHarness(phase: PromotionJournalPhaseV2): Harness {
      const h = createHarness(phase)
      return h
    }

    it('relaunch mode reports restartRequested when the app relaunched', async () => {
      const h = restartHarness('catalog-pending')
      const relaunch = vi.fn(() => ({ relaunched: true }))
      const result = await h.run({ restart: { mode: 'relaunch', relaunch } })
      const ok = expectOk(result)
      expect(ok.restartRequested).toBe(true)
      expect(relaunch).toHaveBeenCalledTimes(1)
    })

    it('relaunch mode with a refused relaunch still reports ok with restartRequested=false', async () => {
      const h = restartHarness('catalog-pending')
      const relaunch = vi.fn(() => ({ relaunched: false }))
      const result = await h.run({ restart: { mode: 'relaunch', relaunch } })
      const ok = expectOk(result)
      expect(ok.restartRequested).toBe(false)
    })

    it('relaunch throw → RELAUNCH_FAILED (journal already cleaned)', async () => {
      const h = restartHarness('catalog-pending')
      const relaunch = vi.fn(() => {
        throw new Error('relaunch exploded')
      })
      expectFail(await h.run({ restart: { mode: 'relaunch', relaunch } }), 'RELAUNCH_FAILED', 'IO')
    })

    it('in-process-reload mode calls reloadRenderer and reports the reload result', async () => {
      const h = restartHarness('catalog-pending')
      const reloadRenderer = vi.fn(() => ({ ok: true, reloaded: true }))
      const result = await h.run({
        restart: { mode: 'in-process-reload', relaunch: () => ({ relaunched: false }), reloadRenderer }
      })
      const ok = expectOk(result)
      expect(ok.restartRequested).toBe(true)
      expect(reloadRenderer).toHaveBeenCalledWith('recovery-v2')
    })

    it('in-process-reload mode without a reloadRenderer → RELAUNCH_FAILED RELOAD_UNAVAILABLE', async () => {
      const h = restartHarness('catalog-pending')
      expectFail(
        await h.run({ restart: { mode: 'in-process-reload', relaunch: () => ({ relaunched: false }) } }),
        'RELAUNCH_FAILED',
        'RELOAD_UNAVAILABLE'
      )
    })

    it('fresh-main mode (no restart option) converges without any restart', async () => {
      const h = restartHarness('catalog-pending')
      const noRestartOptions: RecoveryV2Options = {
        dataRoot: '/test/data',
        catalogBoundary: h.boundary,
        liveDb: fakeLiveDb,
        primitives: {
          probeV2: h.probeV2,
          decide: h.decide,
          readJournal: h.readJournal,
          advance: h.advance,
          cleanupAtPhase: h.cleanupAtPhase,
          rollbackAll: h.rollbackAll,
          markRepairRequiredBeforeInit: h.markRepair,
          verifyInstalledGeneration: h.verifyInstalled,
          verifyPreApplyGeneration: h.verifyPreApply,
          readHandoff: h.readHandoff,
          computeLiveDbReceiptMatch: h.computeLiveDbReceiptMatch
        }
      }
      const result = await runRecoveryV2(noRestartOptions)
      const ok = expectOk(result)
      expect(ok.restartRequested).toBe(false)
      expect(ok.journalCleaned).toBe(true)
    })
  })

  describe('privacy — bounded failure codes only (LOCK-REC-7)', () => {
    it('every failure result carries bounded codes, never paths or messages', async () => {
      const h = createHarness('catalog-pending')
      forceCatalogApply(h)
      h.boundary.applyCandidate = vi.fn(async () => ({ ok: false as const, code: 'RENDERER_FAILED' }))
      const result = await h.run()
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(JSON.stringify(result)).not.toContain('/test/data')
        expect(JSON.stringify(result)).not.toContain('chat.db')
        expect(JSON.stringify(result)).not.toContain('import')
        expect(result.code).toMatch(/^[A-Z_]+$/)
        expect(result.safeCode).toMatch(/^[A-Z0-9_]+$/)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Real-FS verification-exactness tests (LOCK-REC-2/4 — all-new receipts)
// ---------------------------------------------------------------------------

describe('verifyInstalledGeneration / verifyPreApplyGeneration (real FS)', () => {
  let dataRoot: string
  let candidateDir: string
  const fileId = 'file-1'

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
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
    sqlite.close()
  }

  /** Build a valid candidate catalog handoff file (readAndValidateCatalog shape). */
  function writeCandidateCatalog(rows: Array<{ name: string; size: number; sha256: string }>): void {
    const catalogRows = rows.map((r) => ({
      id: r.name.replace(/\.txt$/, ''),
      name: r.name,
      origin_name: r.name,
      size: r.size,
      sha256: r.sha256,
      ext: '.txt',
      type: null,
      created_at: '2020-01-01T00:00:00.000Z',
      count: 1,
      path: `Files/${r.name}`
    }))
    const payload = {
      version: 1,
      sessionId: SESSION_ID,
      createdAt: '2020-01-01T00:00:00.000Z',
      rows: catalogRows,
      referenced: { referencedFileIdCount: catalogRows.length },
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
    realFs.mkdirSync(candidateDir, { recursive: true })
    realFs.writeFileSync(realPath.join(candidateDir, 'files-catalog.json'), JSON.stringify(payload), 'utf8')
  }

  function boundaryReturning(facts: { count: number; sha256: string }): RecoveryV2CatalogBoundary {
    return {
      applyCandidate: vi.fn(async () => ({ ok: true as const, facts })),
      restoreSnapshot: vi.fn(async () => ({ ok: true as const, facts })),
      queryFacts: vi.fn(async () => ({ ok: true as const, facts }))
    }
  }

  beforeEach(() => {
    dataRoot = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'cherry-recv2-exec-'))
    candidateDir = realPath.join(dataRoot, 'chat-import-candidates', CANDIDATE_ID)
    // Live chat.db (candidate installed at the live path).
    makeSealedDb(realPath.join(dataRoot, 'chat.db'), 3)
    // Live Files dir with one payload matching the catalog row.
    realFs.mkdirSync(realPath.join(dataRoot, 'Files'), { recursive: true })
    realFs.writeFileSync(realPath.join(dataRoot, 'Files', `${fileId}.txt`), 'payload-bytes')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    realFs.rmSync(dataRoot, { recursive: true, force: true })
  })

  function candidateEnvironment(): {
    candidateReceipts: PromotionArtifactReceipts
    catalogFacts: { count: number; sha256: string }
    filesEntries: FilesReceiptEntry[]
  } {
    const payload = realFs.readFileSync(realPath.join(dataRoot, 'Files', `${fileId}.txt`))
    const sha256 = realCrypto.createHash('sha256').update(payload).digest('hex')
    writeCandidateCatalog([{ name: `${fileId}.txt`, size: payload.length, sha256 }])
    const filesEntries: FilesReceiptEntry[] = [{ name: `${fileId}.txt`, size: payload.length, sha256 }]
    return {
      filesEntries,
      catalogFacts: (() => {
        const rows = [
          {
            id: fileId,
            name: `${fileId}.txt`,
            size: payload.length,
            count: 1
          }
        ]
        const receipt = computeCatalogReceipt(rows)
        return { count: receipt.count, sha256: receipt.sha256 }
      })(),
      candidateReceipts: {
        db: { sha256: sha('a'), size: realFs.statSync(realPath.join(dataRoot, 'chat.db')).size },
        files: computeFilesReceipt(filesEntries),
        catalog: computeCatalogReceipt([{ id: fileId, name: `${fileId}.txt`, size: payload.length, count: 1 }])
      }
    }
  }

  it('verifies a fully matching all-new generation (db + Files + catalog receipts exact)', async () => {
    const env = candidateEnvironment()
    // The live db receipt must match candidateReceipts.db — compute it from
    // the real live file.
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const candidateReceipts: PromotionArtifactReceipts = { ...env.candidateReceipts, db: liveDbReceipt }
    const boundary = boundaryReturning(env.catalogFacts)

    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(true)
    await expect(verifyPreApplyGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, 3)).resolves.toBe(true)
  })

  it('fails closed when the live DB bytes diverge from the candidate db receipt', async () => {
    const env = candidateEnvironment()
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const candidateReceipts: PromotionArtifactReceipts = { ...env.candidateReceipts, db: liveDbReceipt }
    const boundary = boundaryReturning(env.catalogFacts)
    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(true)

    // Tamper: swap a byte in the live db.
    const livePath = realPath.join(dataRoot, 'chat.db')
    const fd = realFs.openSync(livePath, 'r+')
    realFs.writeSync(fd, Buffer.from('X'), 0, 1, 0)
    realFs.closeSync(fd)

    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(false)
  })

  it('fails closed when a Files payload diverges from the catalog (tampered Files)', async () => {
    const env = candidateEnvironment()
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const candidateReceipts: PromotionArtifactReceipts = { ...env.candidateReceipts, db: liveDbReceipt }
    const boundary = boundaryReturning(env.catalogFacts)
    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(true)

    realFs.writeFileSync(realPath.join(dataRoot, 'Files', `${fileId}.txt`), 'tampered-bytes')

    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(false)
    await expect(verifyPreApplyGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, 3)).resolves.toBe(false)
  })

  it('fails closed on a re-query catalog facts mismatch', async () => {
    const env = candidateEnvironment()
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const candidateReceipts: PromotionArtifactReceipts = { ...env.candidateReceipts, db: liveDbReceipt }
    // The re-query returns facts that do NOT match the candidate receipt.
    const boundary = boundaryReturning({ count: 0, sha256: sha('0') })
    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(false)
  })

  it('fails closed when the journaled candidate files receipt diverges (tampered journal)', async () => {
    const env = candidateEnvironment()
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const boundary = boundaryReturning(env.catalogFacts)
    const tamperedReceipts: PromotionArtifactReceipts = {
      ...env.candidateReceipts,
      db: liveDbReceipt,
      files: { count: 99, totalBytes: 99, sha256: sha('9') }
    }
    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, tamperedReceipts, boundary, 3)).resolves.toBe(false)
  })

  it('fails closed when the candidate catalog handoff is tampered (pre-apply receipt mismatch)', async () => {
    const env = candidateEnvironment()
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const candidateReceipts: PromotionArtifactReceipts = { ...env.candidateReceipts, db: liveDbReceipt }
    await expect(verifyPreApplyGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, 3)).resolves.toBe(true)

    // Tamper: rewrite the handoff with a different payload size.
    writeCandidateCatalog([{ name: `${fileId}.txt`, size: 1, sha256: sha('5') }])
    await expect(verifyPreApplyGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, 3)).resolves.toBe(false)
  })

  it('fails closed when the live DB is missing entirely', async () => {
    const env = candidateEnvironment()
    const liveDbReceipt = await computeDbReceipt(realPath.join(dataRoot, 'chat.db'))
    const candidateReceipts: PromotionArtifactReceipts = { ...env.candidateReceipts, db: liveDbReceipt }
    realFs.rmSync(realPath.join(dataRoot, 'chat.db'))
    const boundary = boundaryReturning(env.catalogFacts)
    await expect(verifyInstalledGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, boundary, 3)).resolves.toBe(false)
    await expect(verifyPreApplyGeneration(dataRoot, CANDIDATE_ID, candidateReceipts, 3)).resolves.toBe(false)
  })
})
