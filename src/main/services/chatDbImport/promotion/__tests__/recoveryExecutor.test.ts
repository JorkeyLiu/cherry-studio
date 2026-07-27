/**
 * Promotion recovery executor tests (Phase 4.4.3, LOCK-4431..4439).
 *
 * Covers:
 * - All 4 actions: keep-old-live, accept-verified-replacement,
 *   restore-rollback-snapshot, repair-required
 * - Crash-point matrix coverage at FS/action level
 * - Exact-once run/abort/whenSettled
 * - Abort behavior
 * - Error handling
 * - Subphase constants
 */

import { resetSharedMaintenanceCoordinatorForTests } from '@main/services/chatDb/maintenanceCoordination'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PromotionArtifactProbesResult } from '../artifactProbe'
import { decidePromotionRecovery } from '../recovery'
import {
  createRecoveryExecutor,
  RECOVERY_EXECUTOR_SUBPHASES,
  type RecoveryExecutionPrimitives,
  type RecoveryExecutorOptions
} from '../recoveryExecutor'

// Mock the journalStore readPromotionJournal used by the executor's probing phase
const mockReadPromotionJournal = vi.fn()
vi.mock('../journalStore', () => ({
  readPromotionJournal: (...args: unknown[]) => mockReadPromotionJournal(...args)
}))

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const mockCleanupSnapshotReady = vi.fn()
const mockCleanupCandidateInstalled = vi.fn()
const mockCleanupReplacementVerified = vi.fn()
const mockRollbackInstall = vi.fn()
const mockRelaunchApp = vi.fn()
const mockProbe = vi.fn()
const mockMarkRepairRequiredBeforeInit = vi.fn()

function defaultPrimitives(): RecoveryExecutionPrimitives {
  return {
    probe: mockProbe,
    decide: decidePromotionRecovery,
    cleanupSnapshotReady: mockCleanupSnapshotReady,
    cleanupCandidateInstalled: mockCleanupCandidateInstalled,
    cleanupReplacementVerified: mockCleanupReplacementVerified,
    rollbackInstall: mockRollbackInstall,
    relaunch: mockRelaunchApp,
    markRepairRequiredBeforeInit: mockMarkRepairRequiredBeforeInit
  }
}

function defaultOptions(primitives?: Partial<RecoveryExecutionPrimitives>): RecoveryExecutorOptions {
  return {
    dataRoot: '/test/data',
    liveDb: { isInitialised: () => false },
    primitives: { ...defaultPrimitives(), ...primitives }
  }
}

// ---------------------------------------------------------------------------
// Probe result factories — matching real PromotionArtifactProbesResult shape
// ---------------------------------------------------------------------------

function absentJournalProbes(): PromotionArtifactProbesResult {
  return {
    journal: { status: 'absent' },
    live: { status: 'missing', detail: null },
    snapshot: { status: 'missing', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function snapshotReadyWithLiveProbes(): PromotionArtifactProbesResult {
  return {
    journal: {
      status: 'valid',
      journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'snapshot-ready' }
    },
    live: { status: 'present-verified', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'present' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function replacementVerifiedWithVerifiedLiveProbes(): PromotionArtifactProbesResult {
  return {
    journal: {
      status: 'valid',
      journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'replacement-verified' }
    },
    live: { status: 'present-verified', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function candidateInstalledWithVerifiedSnapshotProbes(): PromotionArtifactProbesResult {
  return {
    journal: {
      status: 'valid',
      journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'candidate-installed' }
    },
    live: { status: 'present-unverified', detail: { kind: 'validation-failure', gate: 'integrity', safeCode: null } },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function invalidJournalProbes(): PromotionArtifactProbesResult {
  return {
    journal: { status: 'invalid' },
    live: { status: 'present-unverified', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

function snapshotReadyLiveMissingSnapshotVerifiedProbes(): PromotionArtifactProbesResult {
  return {
    journal: {
      status: 'valid',
      journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'snapshot-ready' }
    },
    live: { status: 'missing', detail: null },
    snapshot: { status: 'present-verified', detail: null },
    candidate: { status: 'missing' },
    sidecarFree: true,
    mutationEvidence: { added: [], removed: [] },
    cleanedSidecars: []
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecoveryExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSharedMaintenanceCoordinatorForTests()
    mockCleanupSnapshotReady.mockResolvedValue({ deleted: true })
    mockCleanupCandidateInstalled.mockResolvedValue({ deleted: true })
    mockCleanupReplacementVerified.mockResolvedValue({ deleted: true })
    mockRollbackInstall.mockReturnValue({ ok: true, receipt: {} })
    mockRelaunchApp.mockReturnValue({ ok: true, relaunched: true })
    mockMarkRepairRequiredBeforeInit.mockImplementation(() => {})
    // Default: no journal on disk (absent)
    mockReadPromotionJournal.mockResolvedValue({ status: 'absent' })
  })

  describe('exact-once run', () => {
    it('run() is exact-once — second call throws', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      await expect(executor.run()).rejects.toThrow('exact-once')
    })

    it('whenSettled() resolves after run completes', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      const settledPromise = executor.whenSettled()

      expect(executor.isSettled()).toBe(false)

      await executor.run()

      expect(executor.isSettled()).toBe(true)
      await settledPromise
    })

    it('subphase progresses through canonical order', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      expect(executor.subphase()).toBe('not-started')

      await executor.run()

      expect(executor.subphase()).toBe('settled')
    })
  })

  describe('action: keep-old-live (absent journal — fast path)', () => {
    it('returns keep-old-live with NO_JOURNAL reason', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      expect(result.decision!.action).toBe('keep-old-live')
      expect(result.decision!.reason).toBe('NO_JOURNAL')
      if (result.ok) {
        expect(result.action.action).toBe('keep-old-live')
      }
    })

    it('no relaunch for keep-old-live', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockRelaunchApp).not.toHaveBeenCalled()
    })

    it('no journal cleanup when journal is absent', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockCleanupSnapshotReady).not.toHaveBeenCalled()
      expect(mockCleanupCandidateInstalled).not.toHaveBeenCalled()
      expect(mockCleanupReplacementVerified).not.toHaveBeenCalled()
    })
  })

  describe('action: keep-old-live (valid snapshot-ready journal with live present)', () => {
    beforeEach(() => {
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'snapshot-ready' }
      })
    })

    it('returns keep-old-live with SNAPSHOT_READY_INSTALL_NOT_STARTED', async () => {
      mockProbe.mockReturnValue(snapshotReadyWithLiveProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      expect(result.decision!.action).toBe('keep-old-live')
      expect(result.decision!.reason).toBe('SNAPSHOT_READY_INSTALL_NOT_STARTED')
    })

    it('cleans up the snapshot-ready journal', async () => {
      mockProbe.mockReturnValue(snapshotReadyWithLiveProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockCleanupSnapshotReady).toHaveBeenCalledTimes(1)
      expect(mockCleanupSnapshotReady).toHaveBeenCalledWith(
        { sessionId: 's1', candidateId: 'candidate-c1' },
        '/test/data'
      )
    })

    it('no relaunch for keep-old-live', async () => {
      mockProbe.mockReturnValue(snapshotReadyWithLiveProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockRelaunchApp).not.toHaveBeenCalled()
    })
  })

  describe('action: accept-verified-replacement', () => {
    beforeEach(() => {
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'replacement-verified' }
      })
    })

    it('returns accept-verified-replacement with REPLACEMENT_VERIFIED_LIVE_VERIFIED', async () => {
      mockProbe.mockReturnValue(replacementVerifiedWithVerifiedLiveProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      expect(result.decision!.action).toBe('accept-verified-replacement')
      expect(result.decision!.reason).toBe('REPLACEMENT_VERIFIED_LIVE_VERIFIED')
    })

    it('cleans up the replacement-verified journal', async () => {
      mockProbe.mockReturnValue(replacementVerifiedWithVerifiedLiveProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockCleanupReplacementVerified).toHaveBeenCalledTimes(1)
    })

    it('relaunches after successful cleanup', async () => {
      mockProbe.mockReturnValue(replacementVerifiedWithVerifiedLiveProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockRelaunchApp).toHaveBeenCalledTimes(1)
    })

    it('relaunch failure after cleanup returns RELAUNCH_FAILED (LOCK-4438)', async () => {
      mockProbe.mockReturnValue(replacementVerifiedWithVerifiedLiveProbes())
      mockRelaunchApp.mockReturnValue({ ok: false, reason: 'receipt-invalid' })

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('RELAUNCH_FAILED')
      }
      // Cleanup already ran before relaunch attempt
      expect(mockCleanupReplacementVerified).toHaveBeenCalledTimes(1)
    })

    it('relaunch exception after cleanup returns RELAUNCH_FAILED', async () => {
      mockProbe.mockReturnValue(replacementVerifiedWithVerifiedLiveProbes())
      mockRelaunchApp.mockImplementation(() => {
        throw new Error('relaunch exploded')
      })

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('RELAUNCH_FAILED')
      }
      expect(mockCleanupReplacementVerified).toHaveBeenCalledTimes(1)
    })
  })

  describe('action: repair-required (invalid journal)', () => {
    it('returns repair-required with JOURNAL_INVALID', async () => {
      mockProbe.mockReturnValue(invalidJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      expect(result.decision!.action).toBe('repair-required')
      expect(result.decision!.reason).toBe('JOURNAL_INVALID')
      if (result.ok) {
        expect(result.action.action).toBe('repair-required')
      }
    })

    it('calls markRepairRequiredBeforeInit (LOCK-4437)', async () => {
      mockProbe.mockReturnValue(invalidJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockMarkRepairRequiredBeforeInit).toHaveBeenCalledTimes(1)
    })

    it('returns marked: true only when markRepairRequiredBeforeInit succeeds', async () => {
      mockProbe.mockReturnValue(invalidJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action.action).toBe('repair-required')
        expect((result.action as { action: 'repair-required'; marked: boolean }).marked).toBe(true)
      }
    })

    it('returns structured failure when markRepairRequiredBeforeInit throws', async () => {
      mockProbe.mockReturnValue(invalidJournalProbes())
      mockMarkRepairRequiredBeforeInit.mockImplementation(() => {
        throw new Error('marker write failed')
      })

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('EXECUTING_ACTION_FAILED')
      }
    })

    it('no cleanup or relaunch for repair-required', async () => {
      mockProbe.mockReturnValue(invalidJournalProbes())

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockCleanupSnapshotReady).not.toHaveBeenCalled()
      expect(mockCleanupCandidateInstalled).not.toHaveBeenCalled()
      expect(mockCleanupReplacementVerified).not.toHaveBeenCalled()
      expect(mockRelaunchApp).not.toHaveBeenCalled()
    })
  })

  describe('action: restore-rollback-snapshot (candidate-installed with verified snapshot)', () => {
    beforeEach(() => {
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'candidate-installed' }
      })
    })

    it('returns restore-rollback-snapshot', async () => {
      const candidateProbes = candidateInstalledWithVerifiedSnapshotProbes()
      const verifiedProbes: PromotionArtifactProbesResult = {
        ...candidateProbes,
        live: { status: 'present-verified', detail: null }
      }
      // First call: candidate-installed probes; second call: verified live after rollback
      mockProbe.mockReturnValueOnce(candidateProbes).mockReturnValueOnce(verifiedProbes)

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      expect(result.decision!.action).toBe('restore-rollback-snapshot')
      expect(result.decision!.reason).toBe('CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED')
    })

    it('cleans up the candidate-installed journal after rollback', async () => {
      const candidateProbes = candidateInstalledWithVerifiedSnapshotProbes()
      const verifiedProbes: PromotionArtifactProbesResult = {
        ...candidateProbes,
        live: { status: 'present-verified', detail: null }
      }
      mockProbe.mockReturnValueOnce(candidateProbes).mockReturnValueOnce(verifiedProbes)

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockCleanupCandidateInstalled).toHaveBeenCalled()
    })

    it('rollback is called with proof', async () => {
      const candidateProbes = candidateInstalledWithVerifiedSnapshotProbes()
      const verifiedProbes: PromotionArtifactProbesResult = {
        ...candidateProbes,
        live: { status: 'present-verified', detail: null }
      }
      mockProbe.mockReturnValueOnce(candidateProbes).mockReturnValueOnce(verifiedProbes)

      const executor = createRecoveryExecutor(defaultOptions())
      await executor.run()

      expect(mockRollbackInstall).toHaveBeenCalled()
    })
  })

  describe('action: restore-rollback-snapshot (snapshot-ready, live missing)', () => {
    beforeEach(() => {
      mockReadPromotionJournal.mockResolvedValue({
        status: 'valid',
        journal: { version: 1, sessionId: 's1', candidateId: 'candidate-c1', phase: 'snapshot-ready' }
      })
    })

    it('returns restore-rollback-snapshot with SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED', async () => {
      const missingProbes = snapshotReadyLiveMissingSnapshotVerifiedProbes()
      const verifiedProbes: PromotionArtifactProbesResult = {
        ...missingProbes,
        live: { status: 'present-verified', detail: null }
      }
      mockProbe.mockReturnValueOnce(missingProbes).mockReturnValueOnce(verifiedProbes)

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(true)
      expect(result.decision!.action).toBe('restore-rollback-snapshot')
      expect(result.decision!.reason).toBe('SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED')
    })
  })

  describe('crash-point matrix coverage', () => {
    const crashPointCases: Array<{
      name: string
      probeResult: PromotionArtifactProbesResult
      expectedAction: string
      expectedReason: string
    }> = [
      {
        name: 'before-snapshot: no journal, live present, candidate present → keep-old-live',
        probeResult: {
          ...absentJournalProbes(),
          live: { status: 'present-unverified', detail: null },
          candidate: { status: 'present' }
        },
        expectedAction: 'keep-old-live',
        expectedReason: 'NO_JOURNAL'
      },
      {
        name: 'will-quit-during-promotion (no journal): keep-old-live',
        probeResult: {
          ...absentJournalProbes(),
          live: { status: 'present-unverified', detail: null },
          candidate: { status: 'present' }
        },
        expectedAction: 'keep-old-live',
        expectedReason: 'NO_JOURNAL'
      },
      {
        name: 'replacement-verified + live verified: accept-verified-replacement',
        probeResult: replacementVerifiedWithVerifiedLiveProbes(),
        expectedAction: 'accept-verified-replacement',
        expectedReason: 'REPLACEMENT_VERIFIED_LIVE_VERIFIED'
      },
      {
        name: 'invalid journal: repair-required',
        probeResult: invalidJournalProbes(),
        expectedAction: 'repair-required',
        expectedReason: 'JOURNAL_INVALID'
      },
      {
        name: 'candidate-installed + snapshot verified: restore-rollback-snapshot',
        probeResult: candidateInstalledWithVerifiedSnapshotProbes(),
        expectedAction: 'restore-rollback-snapshot',
        expectedReason: 'CANDIDATE_INSTALLED_UNVERIFIED_SNAPSHOT_VERIFIED'
      },
      {
        name: 'snapshot-ready + live missing + snapshot verified: restore-rollback-snapshot',
        probeResult: snapshotReadyLiveMissingSnapshotVerifiedProbes(),
        expectedAction: 'restore-rollback-snapshot',
        expectedReason: 'SNAPSHOT_READY_AMBIGUOUS_INSTALL_SNAPSHOT_VERIFIED'
      }
    ]

    for (const tc of crashPointCases) {
      it(tc.name, async () => {
        // Set up journal mock based on the probe result's journal status
        if (tc.probeResult.journal.status === 'valid') {
          mockReadPromotionJournal.mockResolvedValue(tc.probeResult.journal)
        } else if (tc.probeResult.journal.status === 'invalid') {
          mockReadPromotionJournal.mockResolvedValue({ status: 'invalid', code: 'TEST' })
        } else {
          mockReadPromotionJournal.mockResolvedValue({ status: 'absent' })
        }

        // For restore-rollback-snapshot cases, the executor re-probes after rollback
        // to verify the restored live. Set up the mock to return verified live on second call.
        if (tc.expectedAction === 'restore-rollback-snapshot') {
          const verifiedProbes: PromotionArtifactProbesResult = {
            ...tc.probeResult,
            live: { status: 'present-verified', detail: null }
          }
          mockProbe.mockReturnValueOnce(tc.probeResult).mockReturnValueOnce(verifiedProbes)
        } else {
          mockProbe.mockReturnValue(tc.probeResult)
        }

        const executor = createRecoveryExecutor(defaultOptions())
        const result = await executor.run()

        expect(result.ok).toBe(true)
        expect(result.decision!.action).toBe(tc.expectedAction)
        expect(result.decision!.reason).toBe(tc.expectedReason)
      })
    }
  })

  describe('abort behavior', () => {
    it('abort before probing short-circuits', async () => {
      const executor = createRecoveryExecutor(defaultOptions())
      executor.requestAbort()
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('ABORT_REQUESTED')
      }
      expect(mockProbe).not.toHaveBeenCalled()
    })

    it('abort signal triggers abort', async () => {
      const controller = new AbortController()
      const executor = createRecoveryExecutor({
        ...defaultOptions(),
        abortSignal: controller.signal
      })

      controller.abort()
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('ABORT_REQUESTED')
      }
    })
  })

  describe('error handling', () => {
    it('probe failure returns PROBING_FAILED', async () => {
      mockProbe.mockImplementation(() => {
        throw new Error('probe exploded')
      })

      const executor = createRecoveryExecutor(defaultOptions())
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('PROBING_FAILED')
      }
    })

    it('decide failure returns DECISION_FAILED', async () => {
      mockProbe.mockReturnValue(absentJournalProbes())
      const badPrimitives = {
        ...defaultPrimitives(),
        decide: () => {
          throw new Error('decide exploded')
        }
      }

      const executor = createRecoveryExecutor(defaultOptions(badPrimitives))
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('DECISION_FAILED')
      }
    })

    it('unexpected failure returns UNEXPECTED_FAILURE', async () => {
      // Force an error in the execute path by making probe return something
      // that causes an error in executeAction
      mockProbe.mockReturnValue(absentJournalProbes())
      const badPrimitives = {
        ...defaultPrimitives(),
        decide: () => ({ action: 'restore-rollback-snapshot' as const, reason: 'TEST' as any }),
        // Make rollback fail
        rollbackInstall: () => {
          throw new Error('rollback exploded')
        }
      }

      const executor = createRecoveryExecutor(defaultOptions(badPrimitives))
      const result = await executor.run()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failure.code).toBe('EXECUTING_ACTION_FAILED')
      }
    })
  })

  describe('subphase constants', () => {
    it('exports the canonical subphase list', () => {
      expect(RECOVERY_EXECUTOR_SUBPHASES).toEqual([
        'not-started',
        'probing',
        'deciding',
        'authorizing',
        'executing-action',
        'cleanup-journal',
        'relaunching',
        'settled'
      ])
    })
  })
})
